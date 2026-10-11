"use strict";

// Transições do Payment a partir do status da cobrança no Opa Pingou (REA-6).
// Pix pago depois de vencer ou de cancelado é honrado (o dinheiro entrou); EXPIRED e CANCELED
// só saem de pendente, então um charge.expired atrasado nunca desfaz um CONFIRMED.

const TARGET = { PAID: "CONFIRMED", EXPIRED: "EXPIRED", CANCELED: "CANCELED" };

const FROM = {
  CONFIRMED: ["PEDING_PAYMENT", "EXPIRED", "CANCELED"],
  EXPIRED: ["PEDING_PAYMENT"],
  CANCELED: ["PEDING_PAYMENT"],
};

const targetFor = (chargeStatus) => TARGET[String(chargeStatus || "").toUpperCase()] || null;

const allowedFrom = (target) => FROM[target] || [];

const canTransition = (current, target) => allowedFrom(target).includes(current);

// Campos de data que acompanham cada destino.
const stampFor = (target, now = new Date()) => {
  if (target === "CONFIRMED") return { confirmed_at: now };
  if (target === "EXPIRED") return { expired_at: now };
  if (target === "CANCELED") return { canceled_at: now };
  return {};
};

module.exports = { targetFor, allowedFrom, canTransition, stampFor };
