"use strict";

/**
 * coupon controller
 */

const { createCoreController } = require("@strapi/strapi").factories;
const { normalizeCpf } = require("../../../utils/cpf");
const { quote } = require("../../signup/services/reserve");

module.exports = createCoreController("api::coupon.coupon", ({ strapi }) => ({
  // POST /api/coupon/preview { event_id, batch_id, code, is_student, cpf? } (REA-6): o mesmo
  // cálculo da inscrição, sem reservar nada. O navegador só exibe.
  async preview(ctx) {
    const body = ctx.request.body || {};
    const eventId = Number(body.event_id);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return ctx.send({ valid: false, message: "Evento inválido." }, 400);
    }
    const event = await strapi.db.query("api::event.event").findOne({ where: { id: eventId }, select: ["id"] });
    if (!event) return ctx.send({ valid: false, message: "Evento não encontrado." }, 404);
    const cpf = body.cpf ? normalizeCpf(body.cpf) : null;

    const q = await quote({
      eventId,
      batchId: body.batch_id,
      couponCode: body.code,
      isStudent: body.is_student,
      cpf,
    });
    if (q.error) return ctx.send({ valid: false, message: q.error.message }, 200);

    const p = q.priced;
    const message =
      p.discountKind === "student" && body.code
        ? "A meia-entrada dá um desconto maior ou igual: o cupom não será usado."
        : p.discountKind === "coupon"
          ? "Cupom aplicado."
          : null;
    return ctx.send(
      {
        valid: true,
        message,
        discount_kind: p.discountKind,
        original_value: p.originalCents,
        final_value: p.finalCents,
        discount_cents: p.discountCents,
        min_charge_applied: p.minApplied,
        min_charge_cents: q.minChargeCents,
        coupon_consumed: p.couponConsumed,
      },
      200
    );
  },
}));
