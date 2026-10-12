"use strict";

// REA-22: quem já tem a inscrição no evento. "Já inscrito" é a inscrição que segura a vaga:
// sem pagamento (importada, manual) ou confirmada, ou com Pix do Opa Pingou ainda no prazo
// (a pessoa recebe de novo o link do pagamento). Vencida, cancelada ou Pix Aí antigo pendente
// não seguram: a inscrição nova (ou a nova tentativa) segue.

const PROVIDER = "opapingou";

const holdsPlace = (payment, now = new Date()) => {
  if (!payment || !payment.status) return true;
  if (payment.status === "CONFIRMED") return true;
  if (payment.status !== "PEDING_PAYMENT" || payment.provider !== PROVIDER) return false;
  return !!payment.expires_at && new Date(payment.expires_at).getTime() > now.getTime();
};

// A primeira que segura a vaga, preferindo a confirmada à que espera o Pix.
const pickHolder = (signups, now = new Date()) => {
  const holding = (signups || []).filter((s) => s && holdsPlace(s.payment, now));
  return holding.find((s) => !s.payment || s.payment.status === "CONFIRMED") || holding[0] || null;
};

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

module.exports = { holdsPlace, pickHolder, normalizeEmail };
