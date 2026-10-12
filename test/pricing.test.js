const test = require("node:test");
const assert = require("node:assert/strict");
const { price, couponWindow, minChargeFor } = require("../src/utils/pricing");

const pct = (p) => ({ discount_type: "percentage", discount_percentage: p });
const fixed = (c) => ({ discount_type: "fixed", discount_value_cents: c });

test("percentual arredonda o valor final para baixo", () => {
  const r = price({ baseCents: 2999, coupon: pct(15), minChargeCents: 1 });
  assert.deepEqual([r.finalCents, r.discountKind, r.couponConsumed], [2549, "coupon", true]);
  assert.equal(r.discountCents, 450);
});

test("cupom sem discount_type (antigo) é percentual", () => {
  assert.equal(price({ baseCents: 1000, coupon: { discount_percentage: 10 } }).finalCents, 900);
});

test("fixo maior que o preço zera", () => {
  assert.equal(price({ baseCents: 1000, coupon: fixed(5000), minChargeCents: 1 }).finalCents, 0);
});

test("meia e cupom: vale o maior desconto, nunca os dois", () => {
  const r = price({ baseCents: 10000, coupon: pct(60), isStudent: true, studentEligible: true });
  assert.deepEqual([r.finalCents, r.discountKind], [4000, "coupon"]);
  const s = price({ baseCents: 10000, coupon: pct(30), isStudent: true, studentEligible: true });
  assert.deepEqual([s.finalCents, s.discountKind, s.couponConsumed], [5000, "student", false]);
});

test("empate meia × cupom: meia, cupom não consumido", () => {
  const r = price({ baseCents: 10000, coupon: pct(50), isStudent: true, studentEligible: true });
  assert.deepEqual([r.finalCents, r.discountKind, r.couponConsumed], [5000, "student", false]);
});

test("meia arredonda para baixo e só vale em lote elegível", () => {
  assert.equal(price({ baseCents: 999, isStudent: true, studentEligible: true }).finalCents, 499);
  assert.equal(price({ baseCents: 999, isStudent: true, studentEligible: false }).finalCents, 999);
});

test("abaixo do mínimo sobe para o mínimo e marca o aviso", () => {
  const r = price({ baseCents: 1000, coupon: fixed(950), minChargeCents: 100 });
  assert.deepEqual([r.finalCents, r.minApplied, r.discountCents], [100, true, 900]);
});

test("zero não aplica mínimo (inscrição sem cobrança)", () => {
  const r = price({ baseCents: 1000, coupon: pct(100), minChargeCents: 100 });
  assert.deepEqual([r.finalCents, r.minApplied, r.couponConsumed], [0, false, true]);
});

test("sem cupom e sem meia, preço cheio; lote gratuito continua zero", () => {
  assert.equal(price({ baseCents: 5000 }).finalCents, 5000);
  const free = price({ baseCents: 0, coupon: pct(10) });
  assert.deepEqual([free.finalCents, free.discountKind, free.couponConsumed], [0, null, false]);
});

test("janela do cupom: datas vazias usam o período do lote", () => {
  const batch = { valid_from: "2026-01-01T00:00:00Z", valid_until: "2026-02-01T00:00:00Z" };
  assert.deepEqual(couponWindow({}, batch), {
    startsAt: new Date("2026-01-01T00:00:00Z"),
    endsAt: new Date("2026-02-01T00:00:00Z"),
  });
  const w = couponWindow({ starts_at: "2026-01-10T00:00:00Z" }, {});
  assert.deepEqual(w, { startsAt: new Date("2026-01-10T00:00:00Z"), endsAt: null });
});

test("mínimo de cobrança do Opa Pingou, padrão 1", () => {
  assert.equal(minChargeFor({}), 1);
  assert.equal(minChargeFor({ OPAPINGOU_MIN_CHARGE_CENTS: "50" }), 50);
  assert.equal(minChargeFor({ OPAPINGOU_MIN_CHARGE_CENTS: "x" }), 1);
});
