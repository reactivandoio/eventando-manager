"use strict";

// Aprovação manual de inscrição (REA-34). O admin do evento (pelo BFF) confirma uma inscrição cujo
// Payment está pendente, vencido ou cancelado, sem cobrança nova e sem mexer no Opa Pingou: é
// controle interno. O Payment vira CONFIRMED e guarda quem aprovou e quando; value, original_value,
// coupon e batch ficam como estavam (histórico) e quem lê usa manual_approved_at para tratar como
// R$ 0 / fora da receita. Aprovar com lote/evento lotado ou cupom esgotado é permitido: só avisa.
// A transição é condicional (updateMany com o status de origem), então não corre com um webhook.

const { ACTIVE_WHERE, isActivePayment } = require("../../signup/services/reserve");

const APPROVABLE_FROM = ["PEDING_PAYMENT", "EXPIRED", "CANCELED"];

const toId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const idOf = (rel) => (rel && typeof rel === "object" ? toId(rel.id) : toId(rel));

// Só id, email e name de quem aprovou; precisa ao menos de id ou e-mail.
const approverOf = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const str = (v) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, 255));
  const approver = { id: str(raw.id), email: str(raw.email), name: str(raw.name) };
  return approver.id || approver.email ? approver : null;
};

// Por que a inscrição não pode ser aprovada (null = pode).
const reasonFor = (payment) => {
  if (!payment) return "NO_PAYMENT";
  if (payment.status === "CONFIRMED") return payment.manual_approved_at ? "ALREADY_APPROVED" : "ALREADY_CONFIRMED";
  if (payment.status === "REFUND") return "REFUNDED";
  if (!APPROVABLE_FROM.includes(payment.status)) return "ALREADY_CONFIRMED";
  return null;
};

const publicPayment = (p) => ({
  id: p.id,
  status: p.status,
  value: Number(p.value) || 0,
  manual_approved_at: p.manual_approved_at || null,
  manual_approved_by: p.manual_approved_by || null,
});

const publicSignup = (s) => ({
  id: s.id,
  documentId: s.documentId || null,
  name: s.name || null,
  email: s.email || null,
  phone_number: s.phone_number || null,
  cpf: s.cpf || null,
});

const publicEvent = (e) => ({ id: e.id, uuid: e.uuid || null, slug: e.slug || null });

const errorOf = (httpStatus, code) => ({ httpStatus, body: { error: { code } } });

// db: { findSignup(id) → signup com event e payment (com batch e coupon) | null,
//       countActive({ batch? | event? | coupon?, exceptPaymentId }) → pagamentos ativos (ACTIVE_WHERE),
//       approve(paymentId, fromStatuses, data) → count, getPayment(id) }
const createManualApproval = ({ db, log = console, now = () => new Date() }) => {
  // Inscrição do evento, ou null (inexistente, de outro evento ou ids inválidos).
  const load = async ({ eventId, signupId }) => {
    const ev = toId(eventId);
    const sid = toId(signupId);
    if (!ev || !sid) return null;
    const signup = await db.findSignup(sid);
    if (!signup || idOf(signup.event) !== ev) return null;
    return signup;
  };

  // "Estaria acima do limite com esta aprovação": as contagens de reserve.js (ACTIVE_WHERE) sem o
  // próprio pagamento, como em checkCapacity; com ele, passa do limite se os outros já o atingiram.
  const warningsFor = async (signup) => {
    const payment = signup.payment;
    const over = async (limit, filter) => {
      const max = Number(limit) || 0;
      if (!max) return false;
      return (await db.countActive({ ...filter, exceptPaymentId: payment.id })) >= max;
    };
    const warnings = [];
    const batch = payment.batch;
    if (batch && (await over(batch.max_quantity, { batch: idOf(batch) }))) warnings.push("BATCH_FULL");
    if (await over(signup.event.max_slots, { event: idOf(signup.event) })) warnings.push("EVENT_FULL");
    const coupon = payment.coupon;
    if (coupon && (await over(coupon.max_uses, { coupon: idOf(coupon) }))) warnings.push("COUPON_EXHAUSTED");
    return warnings;
  };

  const preview = async ({ eventId, signupId }) => {
    const signup = await load({ eventId, signupId });
    if (!signup) return { approvable: false, reason: "NOT_FOUND", status: null, warnings: [] };
    const payment = signup.payment || null;
    const reason = reasonFor(payment);
    const status = payment ? payment.status : null;
    if (reason) return { approvable: false, reason, status, warnings: [] };
    return { approvable: true, reason: null, status, warnings: await warningsFor(signup) };
  };

  const approvedBody = (signup, payment, alreadyApproved, warnings) => ({
    httpStatus: 200,
    body: {
      approved: true,
      already_approved: alreadyApproved,
      warnings,
      payment: publicPayment(payment),
      signup: publicSignup(signup),
      event: publicEvent(signup.event),
    },
  });

  // Resposta: { httpStatus, body }
  const approve = async ({ eventId, signupId, approvedBy }) => {
    const signup = await load({ eventId, signupId });
    if (!signup) return errorOf(404, "NOT_FOUND");
    const approver = approverOf(approvedBy);
    if (!approver) return errorOf(400, "INVALID_APPROVER");

    const payment = signup.payment || null;
    const reason = reasonFor(payment);
    if (reason === "ALREADY_APPROVED") return approvedBody(signup, payment, true, []);
    if (reason) return errorOf(409, reason);

    const warnings = await warningsFor(signup);
    const at = now();
    const count = await db.approve(payment.id, APPROVABLE_FROM, {
      status: "CONFIRMED",
      confirmed_at: at,
      manual_approved_at: at,
      manual_approved_by: approver,
    });
    const fresh = (await db.getPayment(payment.id)) || payment;
    if (count !== 1) {
      // Outro processo mexeu no pagamento entre a leitura e a transição (webhook ou outra aprovação).
      const after = reasonFor(fresh);
      if (after === "ALREADY_APPROVED") return approvedBody(signup, fresh, true, []);
      return errorOf(409, after || "ALREADY_CONFIRMED");
    }
    log.info(
      `[aprovação manual] pagamento ${payment.id} (inscrição ${signup.id}) de ${payment.status} para CONFIRMED por ${
        approver.email || approver.id
      }`
    );
    return approvedBody(signup, fresh, false, warnings);
  };

  return { preview, approve };
};

// Adaptador do Strapi.
const strapiManualApprovalDb = (strapi) => {
  const payments = () => strapi.db.query("api::payment.payment");
  return {
    findSignup: (id) =>
      strapi.db.query("api::signup.signup").findOne({
        where: { id },
        populate: { event: true, payment: { populate: { batch: true, coupon: true } } },
      }),
    countActive: ({ batch, event, coupon, exceptPaymentId }) =>
      payments().count({
        where: {
          ...ACTIVE_WHERE,
          ...(batch !== undefined ? { batch } : {}),
          ...(event !== undefined ? { event } : {}),
          ...(coupon !== undefined ? { coupon } : {}),
          ...(exceptPaymentId ? { id: { $ne: exceptPaymentId } } : {}),
        },
      }),
    approve: async (id, from, data) => (await payments().updateMany({ where: { id, status: { $in: from } }, data })).count,
    getPayment: (id) => payments().findOne({ where: { id } }),
  };
};

module.exports = { createManualApproval, strapiManualApprovalDb, isActive: isActivePayment, APPROVABLE_FROM };
