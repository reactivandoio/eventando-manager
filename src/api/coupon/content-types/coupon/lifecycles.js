"use strict";

// Cupom (REA-6): código único por evento (o Strapi 4 não declara índice composto), tipo e valor
// travados depois do primeiro uso, e valor válido para o tipo.

const { errors } = require("@strapi/utils");
const { couponWriteError } = require("../../../../utils/coupon-rules");

const { ApplicationError } = errors;
const ACTIVE = ["CONFIRMED", "PEDING_PAYMENT", "REFUND"];

// Relação vinda como id, { id }, { connect: [...] } ou { set: [...] }.
const relationId = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object") return value;
  const list = value.connect || value.set;
  if (Array.isArray(list)) {
    if (!list.length) return value.disconnect ? null : undefined;
    const first = list[0];
    return typeof first === "object" ? first.id : first;
  }
  if (Array.isArray(value.disconnect) && value.disconnect.length) return null;
  return value.id;
};

const check = async ({ data, where }) => {
  if (!data) return;
  const query = strapi.db.query("api::coupon.coupon");
  const existing = where ? await query.findOne({ where, populate: { event: { select: ["id"] } } }) : null;
  const touched = ["code", "event", "discount_type", "discount_percentage", "discount_value_cents"].some(
    (k) => data[k] !== undefined
  );
  if (existing && !touched) return; // só datas, limite ou ativação

  const dataEvent = relationId(data.event);
  const eventId = dataEvent !== undefined ? dataEvent : existing && existing.event ? existing.event.id : null;
  const merged = {
    ...(existing || {}),
    ...data,
    discount_type: data.discount_type ?? (existing ? existing.discount_type : undefined) ?? "percentage",
  };

  const siblings = eventId
    ? await query.findMany({ where: { event: eventId }, select: ["id", "code"] })
    : [];
  const uses = existing
    ? await strapi.db.query("api::payment.payment").count({ where: { coupon: existing.id, status: { $in: ACTIVE } } })
    : 0;

  const message = couponWriteError({ merged, existing, uses, siblings });
  if (message) throw new ApplicationError(message);
};

module.exports = {
  async beforeCreate(event) {
    await check({ data: event.params.data });
  },
  async beforeUpdate(event) {
    await check({ data: event.params.data, where: event.params.where });
  },
};
