"use strict";

// Reserva da inscrição (REA-6): numa transação, trava evento → lote → cupom (sempre nesta ordem,
// para não haver deadlock), expira os Pix vencidos do evento, confere vagas, janela e limite do
// cupom e "um cupom por CPF no evento", e grava o Payment pendente (ou confirmado, se o valor
// final é zero) e a inscrição. A cobrança no provedor é criada depois, fora da trava.
//
// No InnoDB o primeiro SELECT ... FOR UPDATE tem de vir antes de qualquer leitura comum na
// transação: o snapshot das contagens só é tirado depois da trava, quando a inscrição anterior
// já gravou.

const { price, couponWindow, minChargeFor } = require("../../../utils/pricing");

const ACTIVE = ["CONFIRMED", "PEDING_PAYMENT"];
const RESERVATION_MS = 15 * 60 * 1000; // FIFTEEN_MIN, igual à validade do Pix

const fail = (message, status = 400) => ({ error: { status, message } });

const lockRow = (trx, table, id) =>
  strapi.db.connection(table).transacting(trx).where({ id }).forUpdate().first();

const toId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Pix vencidos do evento voltam a liberar vaga e cupom.
const expireOverdue = async (eventId, now) => {
  const overdue = await strapi.db.query("api::payment.payment").findMany({
    where: {
      event: eventId,
      provider: "opapingou",
      status: "PEDING_PAYMENT",
      expires_at: { $lt: now },
    },
    select: ["id"],
  });
  if (!overdue.length) return 0;
  const { count } = await strapi.db.query("api::payment.payment").updateMany({
    where: { id: { $in: overdue.map((p) => p.id) }, status: "PEDING_PAYMENT" },
    data: { status: "EXPIRED", expired_at: now },
  });
  return count;
};

// Regras do cupom que não dependem do preço. Usada também pelo preview (sem trava).
const checkCoupon = async ({ code, eventId, batch, cpf, now = new Date(), ignorePaymentId = null }) => {
  const coupon = await strapi.db.query("api::coupon.coupon").findOne({
    where: { code: { $eqi: String(code).trim() }, event: eventId },
    populate: { batches: { select: ["id"] } },
  });
  if (!coupon || !coupon.enabled) return { message: "Cupom inválido ou desativado." };

  const { startsAt, endsAt } = couponWindow(coupon, batch);
  if (startsAt && now < startsAt) return { message: "Este cupom ainda não está valendo." };
  if (endsAt && now > endsAt) return { message: "Este cupom já expirou." };

  if (coupon.batches?.length && !coupon.batches.some((b) => Number(b.id) === Number(batch.id))) {
    return { message: "Este cupom não vale para este lote." };
  }

  const notThis = ignorePaymentId ? { id: { $ne: ignorePaymentId } } : {};
  if (coupon.max_uses) {
    const uses = await strapi.db.query("api::payment.payment").count({
      where: { coupon: coupon.id, status: { $in: ACTIVE }, ...notThis },
    });
    if (uses >= coupon.max_uses) return { message: "Este cupom atingiu o limite de usos." };
  }

  if (cpf) {
    const usedByCpf = await strapi.db.query("api::payment.payment").count({
      where: {
        event: eventId,
        coupon: { id: { $notNull: true } },
        status: { $in: ACTIVE },
        signup: { cpf },
        ...notThis,
      },
    });
    if (usedByCpf > 0) return { message: "Você já usou um cupom neste evento." };
  }

  return { coupon };
};

// Lote válido para o evento e aberto agora.
const checkBatch = (batch, eventId, now) => {
  if (!batch || !batch.product || !batch.product.event || Number(batch.product.event.id) !== Number(eventId)) {
    return "Lote inválido para este evento.";
  }
  if (!batch.enabled || batch.deleted || !batch.product.enabled) {
    return "Este produto não está disponível no momento.";
  }
  if (batch.valid_from && now < new Date(batch.valid_from)) return "Este lote ainda não abriu.";
  if (batch.valid_until && now > new Date(batch.valid_until)) return "Este lote já encerrou as vendas.";
  return null;
};

const loadBatch = (batchId) =>
  strapi.db.query("api::batch.batch").findOne({
    where: { id: batchId },
    populate: { product: { populate: { event: true } } },
  });

// Preço completo (lote + cupom + meia), sem trava. Usado pela reserva e pelo preview.
const quote = async ({ eventId, batchId, couponCode, isStudent, cpf, provider, now = new Date(), ignorePaymentId = null }) => {
  const id = toId(batchId);
  if (!id) return fail("Selecione um lote para se inscrever.");
  const batch = await loadBatch(id);
  const batchError = checkBatch(batch, eventId, now);
  if (batchError) return fail(batchError);

  let coupon = null;
  if (couponCode && String(couponCode).trim()) {
    const result = await checkCoupon({ code: couponCode, eventId, batch, cpf, now, ignorePaymentId });
    if (!result.coupon) return fail(result.message);
    coupon = result.coupon;
  }

  const minChargeCents = minChargeFor(provider);
  const priced = price({
    baseCents: Number(batch.value) || 0,
    coupon,
    isStudent: !!isStudent,
    studentEligible: !!batch.half_price_eligible,
    minChargeCents,
  });
  return { batch, coupon, priced, minChargeCents };
};

const checkCapacity = async ({ batch, event, ignorePaymentId = null }) => {
  const notThis = ignorePaymentId ? { id: { $ne: ignorePaymentId } } : {};
  if (batch.max_quantity) {
    const used = await strapi.db.query("api::payment.payment").count({
      where: { batch: batch.id, status: { $in: ACTIVE }, ...notThis },
    });
    if (used >= batch.max_quantity) return "As vagas para este lote esgotaram.";
  }
  if (event.max_slots) {
    const used = await strapi.db.query("api::payment.payment").count({
      where: { event: event.id, status: { $in: ACTIVE }, ...notThis },
    });
    if (used >= event.max_slots) return "Este evento já atingiu a lotação máxima.";
  }
  return null;
};

const paymentFields = ({ priced, batch, coupon, provider, kind, now }) => {
  const isFree = priced.finalCents === 0;
  return {
    value: priced.finalCents,
    original_value: priced.originalCents,
    batch: batch.id,
    coupon: priced.couponConsumed && coupon ? coupon.id : null,
    discount_kind: priced.discountKind,
    discount_cents: priced.discountCents,
    min_charge_applied: priced.minApplied,
    provider: isFree ? null : provider,
    kind: !isFree && provider === "opapingou" ? kind : null,
    status: isFree ? "CONFIRMED" : "PEDING_PAYMENT",
    confirmed_at: isFree ? now : null,
    expires_at: !isFree && provider === "opapingou" ? new Date(now.getTime() + RESERVATION_MS) : null,
    payment_identification: isFree ? `FREE_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}` : null,
  };
};

const idempotencyKey = (paymentId, attempt) => `signup-payment-${paymentId}-v${attempt}`;

// Resultado: { error } | { signup, payment, priced, minChargeCents, event, provider, needsCharge, reused }
const reserveSignup = async ({ eventId, body, cpf, provider, kind, now = new Date() }) =>
  strapi.db.transaction(async ({ trx }) => {
    // 1. Travas, nesta ordem: evento, lote, cupom. Antes de qualquer leitura comum.
    const eventRow = await lockRow(trx, "events", eventId);
    if (!eventRow) return fail("Evento não encontrado.", 404);
    const batchId = toId(body.batch_id);
    if (!batchId) return fail("Selecione um lote para se inscrever.");
    await lockRow(trx, "batches", batchId);
    if (body.coupon_code && String(body.coupon_code).trim()) {
      // O evento do cupom fica numa tabela de ligação; trava todo cupom com esse código (o que
      // não for deste evento só espera um pouco). Cupom inexistente é tratado no quote.
      await strapi.db
        .connection("coupons")
        .transacting(trx)
        .whereRaw("LOWER(code) = ?", [String(body.coupon_code).trim().toLowerCase()])
        .forUpdate()
        .select("id");
    }

    // 2. Pix vencidos liberam vaga e cupom.
    await expireOverdue(eventId, now);

    const event = await strapi.db.query("api::event.event").findOne({ where: { id: eventId } });

    // 3. Inscrição repetida.
    const existing = await strapi.db.query("api::signup.signup").findOne({
      where: { email: body.email, event: eventId },
      populate: { payment: true },
    });
    let retryPayment = null;
    if (existing) {
      const p = existing.payment;
      const retryable = p && (p.status === "EXPIRED" || p.status === "CANCELED");
      const openOpa = p && p.status === "PEDING_PAYMENT" && p.provider === "opapingou";
      if (!retryable && !(openOpa && provider === "opapingou")) {
        return fail("Você já está inscrito neste evento!");
      }
      if (openOpa) {
        if ((p.kind || "PIX_QR") === kind) {
          // Mesmo Pix ainda válido: devolve a mesma cobrança (ou tenta criá-la de novo com a
          // mesma Idempotency-Key, se a primeira chamada não terminou).
          return {
            signup: existing,
            payment: p,
            event,
            provider,
            needsCharge: !p.provider_charge_id,
            reused: true,
            priced: {
              originalCents: Number(p.original_value) || 0,
              finalCents: Number(p.value) || 0,
              discountKind: p.discount_kind || null,
              discountCents: Number(p.discount_cents) || 0,
              minApplied: !!p.min_charge_applied,
            },
            minChargeCents: minChargeFor(provider),
          };
        }
        // Trocar Pix por link (ou o contrário) é nova tentativa.
      }
      retryPayment = p; // EXPIRED, CANCELED ou troca de meio: nova tentativa na mesma inscrição
    }

    // 4. Preço e regras (lote, janela, cupom, CPF) e vagas.
    const q = await quote({
      eventId,
      batchId,
      couponCode: body.coupon_code,
      isStudent: body.is_student,
      cpf,
      provider,
      now,
      ignorePaymentId: retryPayment ? retryPayment.id : null,
    });
    if (q.error) return q;
    const capacityError = await checkCapacity({
      batch: q.batch,
      event,
      ignorePaymentId: retryPayment ? retryPayment.id : null,
    });
    if (capacityError) return fail(capacityError);

    const fields = paymentFields({ ...q, provider, kind, now });
    const needsCharge = fields.status === "PEDING_PAYMENT";

    // 5. Grava.
    let payment;
    let signup = existing;
    if (retryPayment) {
      const attempt = (Number(retryPayment.attempt) || 1) + 1;
      const previous = [retryPayment.previous_charge_ids, retryPayment.provider_charge_id]
        .filter(Boolean)
        .join(",");
      payment = await strapi.db.query("api::payment.payment").update({
        where: { id: retryPayment.id },
        data: {
          ...fields,
          event: eventId,
          attempt,
          provider_idempotency_key:
            needsCharge && provider === "opapingou" ? idempotencyKey(retryPayment.id, attempt) : null,
          provider_charge_id: null,
          provider_txid: null,
          pix_br_code: null,
          pix_qr_code: null,
          payment_link: null,
          previous_charge_ids: previous || null,
          canceled_at: null,
          expired_at: null,
        },
      });
      if (cpf && !existing.cpf) {
        signup = await strapi.db.query("api::signup.signup").update({ where: { id: existing.id }, data: { cpf } });
      }
    } else {
      payment = await strapi.db.query("api::payment.payment").create({
        data: { ...fields, event: eventId, attempt: 1 },
      });
      if (needsCharge && provider === "opapingou") {
        payment = await strapi.db.query("api::payment.payment").update({
          where: { id: payment.id },
          data: { provider_idempotency_key: idempotencyKey(payment.id, 1) },
        });
      }
      signup = await strapi.db.query("api::signup.signup").create({
        data: {
          name: body.name,
          email: body.email,
          phone_number: body.phone_number,
          t_shirt_size: body.t_shirt_size,
          additional_information: body.additional_information,
          cpf: cpf || null,
          payment: payment.id,
          event: eventId,
        },
      });
    }

    return {
      signup,
      payment,
      event,
      provider,
      needsCharge,
      reused: false,
      priced: q.priced,
      minChargeCents: q.minChargeCents,
    };
  });

module.exports = { reserveSignup, quote, checkCoupon, checkCapacity, idempotencyKey, ACTIVE };
