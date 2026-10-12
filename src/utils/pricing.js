"use strict";

// Preço da inscrição (REA-6), em centavos inteiros.
// Meia-entrada OU cupom, o maior desconto, nunca os dois; empate = meia (cupom não consumido).
// O valor final arredonda para baixo. Acima de zero e abaixo do mínimo do provedor, sobe para o
// mínimo e marca minApplied (a tela avisa).

const afterCoupon = (base, coupon) => {
  if (!coupon) return null;
  if (coupon.discount_type === "fixed") {
    return Math.max(0, base - Math.floor(Number(coupon.discount_value_cents) || 0));
  }
  const pct = Math.min(100, Math.max(0, Number(coupon.discount_percentage) || 0));
  return Math.floor((base * (100 - pct)) / 100);
};

const price = ({
  baseCents,
  coupon = null,
  isStudent = false,
  studentEligible = false,
  minChargeCents = 1,
}) => {
  const base = Math.max(0, Math.floor(Number(baseCents) || 0));
  const withStudent = isStudent && studentEligible ? Math.floor(base / 2) : null;
  const withCoupon = afterCoupon(base, coupon);
  let finalCents = base;
  let discountKind = null;
  if (withStudent !== null && (withCoupon === null || withStudent <= withCoupon)) {
    finalCents = withStudent;
    discountKind = "student";
  } else if (withCoupon !== null && withCoupon < base) {
    finalCents = withCoupon;
    discountKind = "coupon";
  }
  const min = Math.max(1, Math.floor(Number(minChargeCents) || 1));
  const minApplied = finalCents > 0 && finalCents < min;
  if (minApplied) finalCents = min;
  return {
    originalCents: base,
    discountKind,
    discountCents: base - finalCents,
    finalCents,
    minApplied,
    couponConsumed: discountKind === "coupon",
  };
};

// Janela do cupom: datas vazias valem pelo período do lote.
const couponWindow = (coupon, batch) => ({
  startsAt: coupon.starts_at
    ? new Date(coupon.starts_at)
    : batch?.valid_from
      ? new Date(batch.valid_from)
      : null,
  endsAt: coupon.expires_at
    ? new Date(coupon.expires_at)
    : batch?.valid_until
      ? new Date(batch.valid_until)
      : null,
});

const minChargeFor = (provider, env = process.env) => {
  const raw = provider === "opapingou" ? env.OPAPINGOU_MIN_CHARGE_CENTS : env.PIXAI_MIN_CHARGE_CENTS;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

module.exports = { price, couponWindow, minChargeFor };
