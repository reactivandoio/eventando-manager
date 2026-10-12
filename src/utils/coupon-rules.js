"use strict";

// Regras de escrita do cupom (REA-6), puras. O lifecycle busca o estado atual e chama aqui.

const sameCode = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

// Valor por tipo: percentual 1–100; fixo em centavos inteiros > 0.
const discountError = ({ discount_type: type = "percentage", discount_percentage: pct, discount_value_cents: cents }) => {
  if (type === "fixed") {
    const n = Number(cents);
    return Number.isInteger(n) && n > 0 ? null : "Informe o valor do desconto em centavos (maior que zero).";
  }
  if (type !== "percentage") return "Tipo de desconto inválido.";
  const p = Number(pct);
  return Number.isInteger(p) && p >= 1 && p <= 100 ? null : "O percentual do desconto deve ser de 1 a 100.";
};

// merged: estado depois da escrita; existing: antes (null na criação); uses: usos do cupom;
// siblings: outros cupons do mesmo evento ({ id, code }).
const couponWriteError = ({ merged, existing = null, uses = 0, siblings = [] }) => {
  if (!String(merged.code || "").trim()) return "Informe o código do cupom.";
  if (siblings.some((s) => (!existing || s.id !== existing.id) && sameCode(s.code, merged.code))) {
    return "Já existe um cupom com este código neste evento.";
  }
  if (existing && uses > 0) {
    const was = { type: existing.discount_type || "percentage", pct: existing.discount_percentage, cents: existing.discount_value_cents };
    const now = { type: merged.discount_type || "percentage", pct: merged.discount_percentage, cents: merged.discount_value_cents };
    const changed =
      was.type !== now.type ||
      (now.type === "percentage" && Number(was.pct) !== Number(now.pct)) ||
      (now.type === "fixed" && Number(was.cents) !== Number(now.cents));
    if (changed) return "Este cupom já foi usado: o tipo e o valor do desconto não podem mudar.";
  }
  return discountError(merged);
};

module.exports = { couponWriteError, discountError, sameCode };
