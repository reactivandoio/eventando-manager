"use strict";

// REA-12: os eventos que já tinham lote pago antes da chave por evento continuam cobrando pela
// chave global (OPAPINGOU_API_KEY) até a organização conectar a conta da comunidade no admin.
// Roda uma vez, no boot: depois disso, evento novo só cobra com a conta do próprio evento.

const STORE = { type: "core", name: "opapingou", key: "rea12_legacy_marked" };

// Ids dos eventos com algum lote de valor > 0 (apagados também: já venderam ou vão vender).
const legacyEventIds = (batches) => {
  const ids = new Set();
  for (const b of batches || []) {
    const eventId = b && b.product && b.product.event && b.product.event.id;
    if (eventId && Number(b.value) > 0) ids.add(eventId);
  }
  return [...ids];
};

const markLegacyEvents = async (strapi) => {
  if (await strapi.store.get(STORE)) return { skipped: true };
  const batches = await strapi.db.query("api::batch.batch").findMany({
    where: { value: { $gt: 0 } },
    select: ["id", "value"],
    populate: { product: { select: ["id"], populate: { event: { select: ["id"] } } } },
  });
  const ids = legacyEventIds(batches);
  if (ids.length) {
    await strapi.db.query("api::event.event").updateMany({
      where: { id: { $in: ids } },
      data: { opapingou_legacy: true },
    });
  }
  await strapi.store.set({ ...STORE, value: { at: new Date().toISOString(), events: ids.length } });
  strapi.log.info(`[opapingou] ${ids.length} evento(s) com lote pago seguem na chave global (REA-12)`);
  return { marked: ids.length };
};

module.exports = { legacyEventIds, markLegacyEvents };
