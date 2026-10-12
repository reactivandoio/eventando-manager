"use strict";

// Eventos de webhook do Opa Pingou (REA-6). O BFF verifica a assinatura, grava aqui, responde
// 2xx ao Opa Pingou e pede o processamento depois. Rotas com o token de integração.

const { createCoreController } = require("@strapi/strapi").factories;
const { createOpaPingou } = require("../../../datasources/opapingou");
const { createProcessor, strapiDb } = require("../services/process");

const UID = "api::opapingou-event.opapingou-event";

module.exports = createCoreController(UID, ({ strapi }) => ({
  async store(ctx) {
    const body = ctx.request.body || {};
    const eventId = body.event_id ? String(body.event_id).slice(0, 255) : "";
    if (!eventId) return ctx.send({ error: "event_id é obrigatório" }, 400);

    const existing = await strapi.db.query(UID).findOne({ where: { event_id: eventId }, select: ["id"] });
    if (existing) return ctx.send({ duplicate: true, id: existing.id }, 200);

    try {
      const row = await strapi.db.query(UID).create({
        data: {
          event_id: eventId,
          type: body.type ? String(body.type) : null,
          test_mode: body.test_mode === true,
          charge_id: body.charge_id ? String(body.charge_id) : null,
          payload: body.payload ?? null,
          status: "pending",
          attempts: 0,
        },
      });
      return ctx.send({ duplicate: false, id: row.id }, 201);
    } catch (err) {
      // Dois envios do mesmo evento ao mesmo tempo: o segundo é o repetido.
      const again = await strapi.db.query(UID).findOne({ where: { event_id: eventId }, select: ["id"] });
      if (again) return ctx.send({ duplicate: true, id: again.id }, 200);
      strapi.log.error(`[opapingou] falha ao gravar o evento ${eventId}: ${err && err.message}`);
      return ctx.send({ error: "falha ao gravar o evento" }, 500);
    }
  },

  async process(ctx) {
    const run = createProcessor({ db: strapiDb(strapi), opapingou: createOpaPingou(), log: strapi.log });
    const { httpStatus, body } = await run(ctx.params.eventId);
    return ctx.send(body, httpStatus);
  },

  async pending(ctx) {
    const seconds = Math.max(0, Number(ctx.query.olderThanSeconds ?? 60) || 0);
    const before = new Date(Date.now() - seconds * 1000);
    const rows = await strapi.db.query(UID).findMany({
      where: { status: "pending", createdAt: { $lt: before } },
      select: ["event_id", "type"],
      orderBy: { createdAt: "asc" },
      limit: 50,
    });
    return ctx.send({ data: rows.map((r) => ({ event_id: r.event_id, type: r.type })) }, 200);
  },
}));
