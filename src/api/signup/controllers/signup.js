"use strict";

/**
 * signup controller
 */

const { createCoreController } = require("@strapi/strapi").factories;

const { createOpaPingou, isEnabled } = require("../../../datasources/opapingou");
const { normalizeCpf } = require("../../../utils/cpf");
const { reserveSignup } = require("../services/reserve");
const { pickHolder, normalizeEmail } = require("../../../utils/signup-holder");

const KINDS = ["PIX_QR", "PAYMENT_LINK"];
const CPF_MESSAGE = "Informe um CPF válido.";
const RETRY_MESSAGE = "Não conseguimos gerar o pagamento agora. Tente de novo em instantes.";

// O CPF é obrigatório em toda inscrição nova quando SIGNUP_REQUIRE_CPF=true (ligar depois que o
// BFF e o frontend que mandam o CPF estiverem no ar). Com cupom ele é sempre exigido: a regra
// "um cupom por CPF no evento" depende dele.
const cpfRequired = (body) =>
  String(process.env.SIGNUP_REQUIRE_CPF || "").toLowerCase() === "true" ||
  !!(body.coupon_code && String(body.coupon_code).trim());

const publicSignup = (signup) => {
  if (!signup) return {};
  const { cpf, payment, ...rest } = signup;
  return rest;
};

const chargeMessage = (code) =>
  code === "PAYMENT_LINK_UNAVAILABLE"
    ? "Link indisponível, pague por Pix."
    : "Não foi possível gerar o pagamento. Tente novamente.";

module.exports = createCoreController("api::signup.signup", ({ strapi }) => {
  const paymentQuery = () => strapi.db.query("api::payment.payment");

  // Cria (ou reconsulta pela mesma Idempotency-Key) a cobrança do Opa Pingou fora da trava.
  const createOpaCharge = async ({ payment, event, signup }) => {
    const op = createOpaPingou();
    let charge;
    try {
      ({ charge } = await op.createCharge({
        amountCents: Number(payment.value),
        validity: process.env.OPAPINGOU_CHARGE_VALIDITY || "FIFTEEN_MIN",
        kind: payment.kind || "PIX_QR",
        description: `Inscrição ${event.name || ""} - ${signup.name || ""}`.trim(),
        idempotencyKey: payment.provider_idempotency_key,
      }));
    } catch (err) {
      const code = err && err.code ? err.code : "UNKNOWN";
      strapi.log.warn(
        `[signup] cobrança do pagamento ${payment.id} falhou: code=${code} requestId=${(err && err.requestId) || "-"}`
      );
      if (err && err.retryable) {
        // A cobrança pode ter sido criada: o pendente fica com a mesma chave e a pessoa tenta de
        // novo (mesma cobrança, Idempotent-Replayed).
        return { error: { status: 503, message: RETRY_MESSAGE } };
      }
      await paymentQuery().updateMany({
        where: { id: payment.id, status: "PEDING_PAYMENT" },
        data: { status: "CANCELED", canceled_at: new Date() },
      });
      return { error: { status: 400, message: chargeMessage(code) } };
    }

    try {
      const updated = await paymentQuery().update({
        where: { id: payment.id },
        data: {
          provider_charge_id: charge.id,
          provider_txid: charge.txid || null,
          pix_br_code: charge.brCode || null,
          payment_link: charge.paymentLink || null,
          expires_at: charge.expiresAt ? new Date(charge.expiresAt) : payment.expires_at,
          payment_identification: `opapingou_${charge.id}`,
        },
      });
      return { payment: updated };
    } catch (err) {
      // A cobrança existe no Opa Pingou: nunca cancelar aqui. O pendente fica com a mesma chave;
      // a nova tentativa da pessoa recebe a mesma cobrança e grava de novo.
      strapi.log.error(`[signup] cobrança ${charge.id} criada mas não gravada no pagamento ${payment.id}: ${err && err.code}`);
      return { error: { status: 503, message: RETRY_MESSAGE } };
    }
  };

  return {
    async customCreate(ctx) {
      const eventId = Number(ctx.params.id);
      const body = ctx.request.body || {};
      if (!Number.isInteger(eventId) || eventId <= 0) {
        return ctx.send({ status: "error", message: "Evento inválido." }, 400);
      }

      let cpf = null;
      if (body.cpf !== undefined && body.cpf !== null && String(body.cpf).trim() !== "") {
        cpf = normalizeCpf(body.cpf);
        if (!cpf) return ctx.send({ status: "error", message: CPF_MESSAGE }, 400);
      } else if (cpfRequired(body)) {
        return ctx.send({ status: "error", message: CPF_MESSAGE }, 400);
      }

      const kind = KINDS.includes(body.kind) ? body.kind : "PIX_QR";

      // O Opa Pingou é o único provedor (REA-15); a flag OPAPINGOU_ENABLED vira chave de
      // emergência: desligada, só a inscrição gratuita passa.
      let reserved;
      try {
        reserved = await reserveSignup({ eventId, body, cpf, kind, paidEnabled: isEnabled() });
      } catch (err) {
        strapi.log.error(`[signup] falha ao reservar a inscrição: ${err && err.message}`);
        return ctx.send({ status: "error", message: "Falha ao criar inscrição." }, 400);
      }
      if (reserved.error) {
        const { message, status, code } = reserved.error;
        return ctx.send({ status: "error", message, ...(code ? { code } : {}) }, status);
      }

      let { payment } = reserved;
      const { signup, priced, minChargeCents } = reserved;
      const fullEvent = await strapi.db.query("api::event.event").findOne({ where: { id: eventId } });
      if (reserved.needsCharge) {
        const created = await createOpaCharge({ payment, event: fullEvent, signup });
        if (created.error) {
          return ctx.send({ status: "error", message: created.error.message }, created.error.status);
        }
        payment = created.payment;
      }

      const isFree = Number(payment.value) === 0 && payment.status === "CONFIRMED";
      return ctx.send(
        {
          ...publicSignup(signup),
          signup_id: signup.id,
          payment_id: payment.id,
          payment_provider: isFree ? null : "opapingou",
          kind: payment.kind || null,
          status: payment.status,
          pix_br_code: payment.pix_br_code || null,
          payment_link: payment.payment_link || null,
          expires_at: payment.expires_at || null,
          value: Number(payment.value) || 0,
          original_value: Number(payment.original_value) || 0,
          discount_kind: priced.discountKind || null,
          discount_cents: priced.discountCents || 0,
          min_charge_applied: !!priced.minApplied,
          min_charge_cents: minChargeCents,
          is_free: isFree,
        },
        200
      );
    },

    // REA-22: quem já tem a inscrição do evento, pelo CPF ou por um dos e-mails. Só o BFF
    // (token de API) chega aqui: a resposta traz o e-mail, que o BFF usa para reenviar a
    // confirmação e só mostra mascarado. O CPF nunca volta.
    async holder(ctx) {
      const eventId = Number(ctx.params.id);
      const body = ctx.request.body || {};
      if (!Number.isInteger(eventId) || eventId <= 0) {
        return ctx.send({ status: "error", message: "Evento inválido." }, 400);
      }
      const cpf = body.cpf ? normalizeCpf(body.cpf) : null;
      const emails = [...new Set((Array.isArray(body.emails) ? body.emails : []).map(normalizeEmail).filter(Boolean))].slice(0, 5);
      if (!cpf && emails.length === 0) return ctx.send({ holder: null }, 200);

      const or = [];
      if (cpf) or.push({ cpf });
      emails.forEach((email) => or.push({ email: { $eqi: email } }));
      const signups = await strapi.db.query("api::signup.signup").findMany({
        where: { event: eventId, $or: or },
        populate: { payment: true },
        orderBy: { id: "asc" },
      });
      const holder = pickHolder(signups);
      if (!holder) return ctx.send({ holder: null }, 200);
      const p = holder.payment;
      return ctx.send(
        {
          holder: {
            signup_id: holder.id,
            email: holder.email,
            name: holder.name || null,
            payment_status: p ? p.status : null,
            kind: p ? p.kind || null : null,
          },
        },
        200
      );
    },
  };
});
