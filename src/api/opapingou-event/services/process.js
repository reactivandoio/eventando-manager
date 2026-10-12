"use strict";

// Processamento de um evento de webhook do Opa Pingou já gravado (REA-6). Nunca libera pelo
// corpo do webhook: reconsulta GET /v1/charges/{id} e aplica a transição com updateMany
// condicionado ao status de origem, então evento repetido ou fora de ordem não faz nada.

const { targetFor, allowedFrom, stampFor } = require("../../../utils/payment-transitions");

const CHARGE_TYPES = new Set(["charge.paid", "charge.expired", "charge.canceled", "payment.confirmed"]);
const ALERT_TYPES = new Set(["payment.refunded", "payment.charged_back"]);
const MAX_ATTEMPTS = 10;

const chargeIdOf = (row) => {
  if (row.charge_id) return String(row.charge_id);
  const obj = row.payload && row.payload.data && row.payload.data.object;
  if (!obj) return null;
  if (row.payload.data.type === "charge" && obj.id) return String(obj.id);
  return obj.chargeId ? String(obj.chargeId) : null;
};

const publicPayment = (p) =>
  p && {
    id: p.id,
    value: Number(p.value) || 0,
    status: p.status,
    signup: p.signup
      ? { id: p.signup.id, name: p.signup.name, email: p.signup.email, phone_number: p.signup.phone_number }
      : null,
    event: p.event ? { id: p.event.id, uuid: p.event.uuid, slug: p.event.slug } : null,
  };

// db: { findEvent(eventId), updateEvent(id, data), findPaymentByCharge(chargeId),
//       transition(paymentId, fromStatuses, data) → count, getPayment(id) }
const createProcessor = ({ db, opapingou, log, env = process.env, now = () => new Date() }) => {
  const alert = (msg) => log.error(`[ALERTA][opapingou] ${msg}`);
  const acceptTestMode = String(env.OPAPINGOU_ACCEPT_TEST_MODE || "").toLowerCase() === "true";

  const finish = async (row, status, extra = {}) => {
    await db.updateEvent(row.id, { status, processed_at: now(), last_error: null, ...extra });
  };

  // Resposta: { httpStatus, body }
  return async (eventId) => {
    const row = await db.findEvent(eventId);
    if (!row) return { httpStatus: 404, body: { transitioned: false, ignored: true, reason: "unknown_event" } };

    const ignore = async (reason, extra = {}) => {
      await finish(row, "ignored", { last_error: reason });
      return { httpStatus: 200, body: { transitioned: false, ignored: true, reason, ...extra } };
    };

    if (row.test_mode && !acceptTestMode) return ignore("test_mode");
    if (ALERT_TYPES.has(row.type)) {
      alert(`${row.type} recebido (evento ${row.event_id}); reembolso é manual, conferir no painel`);
      return ignore("alert_only", { alert: true });
    }
    if (!CHARGE_TYPES.has(row.type)) return ignore("type_not_handled");

    const chargeId = chargeIdOf(row);
    if (!chargeId) return ignore("no_charge_id");

    const payment = await db.findPaymentByCharge(chargeId);
    if (!payment) {
      await finish(row, "ignored", { last_error: "unknown_charge" });
      return { httpStatus: 404, body: { transitioned: false, ignored: true, reason: "unknown_charge" } };
    }

    let charge;
    try {
      charge = await opapingou.getCharge(chargeId);
    } catch (err) {
      const attempts = (Number(row.attempts) || 0) + 1;
      const code = (err && err.code) || "UNKNOWN";
      await db.updateEvent(row.id, {
        attempts,
        last_error: code,
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      });
      if (attempts >= MAX_ATTEMPTS) alert(`evento ${row.event_id} falhou ${attempts} vezes (${code})`);
      return { httpStatus: 502, body: { transitioned: false, reason: "charge_lookup_failed", code } };
    }

    const isCurrent = String(payment.provider_charge_id || "") === chargeId;
    const target = targetFor(charge && charge.status);
    let transitioned = false;
    // Cobrança de uma tentativa anterior só pode confirmar (o dinheiro entrou); vencer ou cancelar
    // ela não mexe na tentativa atual.
    if (target && (isCurrent || target === "CONFIRMED")) {
      const data = { status: target, ...stampFor(target, now()) };
      const count = await db.transition(payment.id, allowedFrom(target), data);
      transitioned = count === 1;
      if (transitioned && target === "CONFIRMED" && !isCurrent) {
        alert(`pagamento ${payment.id} confirmado por cobrança anterior ${chargeId}; conferir cobrança em aberto`);
      }
    }

    await finish(row, "processed", { attempts: (Number(row.attempts) || 0) + 1 });
    const fresh = await db.getPayment(payment.id);
    return {
      httpStatus: 200,
      body: { transitioned, status: fresh ? fresh.status : payment.status, payment: publicPayment(fresh || payment) },
    };
  };
};

// Adaptador do Strapi.
const strapiDb = (strapi) => {
  const payments = () => strapi.db.query("api::payment.payment");
  const events = () => strapi.db.query("api::opapingou-event.opapingou-event");
  const populate = { signup: true, event: true };
  return {
    findEvent: (eventId) => events().findOne({ where: { event_id: String(eventId) } }),
    updateEvent: (id, data) => events().update({ where: { id }, data }),
    findPaymentByCharge: async (chargeId) =>
      (await payments().findOne({ where: { provider_charge_id: chargeId }, populate })) ||
      (await payments().findOne({ where: { previous_charge_ids: { $contains: chargeId } }, populate })),
    transition: async (id, from, data) =>
      (await payments().updateMany({ where: { id, status: { $in: from } }, data })).count,
    getPayment: (id) => payments().findOne({ where: { id }, populate }),
  };
};

module.exports = { createProcessor, strapiDb, chargeIdOf, publicPayment };
