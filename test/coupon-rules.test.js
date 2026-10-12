const test = require("node:test");
const assert = require("node:assert/strict");
const { couponWriteError } = require("../src/utils/coupon-rules");

const pct = (over = {}) => ({ code: "PROMO", discount_type: "percentage", discount_percentage: 10, ...over });

test("código repetido no mesmo evento é recusado (sem caixa); em outro evento, aceito", () => {
  assert.match(couponWriteError({ merged: pct(), siblings: [{ id: 1, code: "promo" }] }), /Já existe/);
  assert.equal(couponWriteError({ merged: pct(), siblings: [] }), null);
});

test("editar o próprio cupom não conflita com ele mesmo", () => {
  const existing = { id: 1, ...pct() };
  assert.equal(couponWriteError({ merged: pct(), existing, siblings: [{ id: 1, code: "PROMO" }] }), null);
});

test("troca de tipo ou valor com uso é recusada; sem uso, aceita", () => {
  const existing = { id: 1, ...pct() };
  assert.match(couponWriteError({ merged: pct({ discount_percentage: 20 }), existing, uses: 1 }), /já foi usado/);
  assert.match(
    couponWriteError({ merged: pct({ discount_type: "fixed", discount_value_cents: 500 }), existing, uses: 1 }),
    /já foi usado/
  );
  assert.equal(couponWriteError({ merged: pct({ discount_percentage: 20 }), existing, uses: 0 }), null);
});

test("com uso, mudar só datas/limite/ativação é aceito", () => {
  const existing = { id: 1, ...pct() };
  assert.equal(couponWriteError({ merged: pct({ max_uses: 3, enabled: false }), existing, uses: 5 }), null);
});

test("valor validado pelo tipo", () => {
  assert.match(couponWriteError({ merged: pct({ discount_percentage: 0 }) }), /1 a 100/);
  assert.match(couponWriteError({ merged: pct({ discount_percentage: 101 }) }), /1 a 100/);
  assert.match(couponWriteError({ merged: { code: "X", discount_type: "fixed", discount_value_cents: 0 } }), /centavos/);
  assert.equal(couponWriteError({ merged: { code: "X", discount_type: "fixed", discount_value_cents: 1500 } }), null);
  assert.match(couponWriteError({ merged: { code: " ", discount_percentage: 10 } }), /código/);
});
