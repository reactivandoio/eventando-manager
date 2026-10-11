const test = require("node:test");
const assert = require("node:assert/strict");
const { targetFor, allowedFrom, canTransition, stampFor } = require("../src/utils/payment-transitions");

test("status da cobrança → status do pagamento", () => {
  assert.equal(targetFor("PAID"), "CONFIRMED");
  assert.equal(targetFor("EXPIRED"), "EXPIRED");
  assert.equal(targetFor("CANCELED"), "CANCELED");
  assert.equal(targetFor("PENDING"), null);
  assert.equal(targetFor(undefined), null);
});

test("expired depois de CONFIRMED não sai de CONFIRMED", () => {
  assert.equal(canTransition("CONFIRMED", "EXPIRED"), false);
  assert.equal(canTransition("CONFIRMED", "CANCELED"), false);
});

test("paid depois de EXPIRED ou CANCELED confirma (Pix pago depois de vencer)", () => {
  assert.equal(canTransition("EXPIRED", "CONFIRMED"), true);
  assert.equal(canTransition("CANCELED", "CONFIRMED"), true);
  assert.equal(canTransition("PEDING_PAYMENT", "CONFIRMED"), true);
});

test("CONFIRMED repetido não transiciona de novo; REFUND não é reaberto", () => {
  assert.equal(canTransition("CONFIRMED", "CONFIRMED"), false);
  assert.equal(canTransition("REFUND", "CONFIRMED"), false);
  assert.deepEqual(allowedFrom("EXPIRED"), ["PEDING_PAYMENT"]);
});

test("cada destino carimba a sua data", () => {
  const now = new Date("2026-10-11T00:00:00Z");
  assert.deepEqual(stampFor("CONFIRMED", now), { confirmed_at: now });
  assert.deepEqual(stampFor("EXPIRED", now), { expired_at: now });
  assert.deepEqual(stampFor("CANCELED", now), { canceled_at: now });
});
