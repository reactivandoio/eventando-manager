const test = require("node:test");
const assert = require("node:assert/strict");
const { holdsPlace, pickHolder } = require("../src/utils/signup-holder");

const now = new Date("2026-10-12T12:00:00Z");
const later = "2026-10-12T12:10:00Z";
const earlier = "2026-10-12T11:50:00Z";

test("segura a vaga: sem pagamento, confirmado, ou Pix do Opa Pingou no prazo", () => {
  assert.equal(holdsPlace(null, now), true);
  assert.equal(holdsPlace({ status: "CONFIRMED" }, now), true);
  assert.equal(holdsPlace({ status: "PEDING_PAYMENT", provider: "opapingou", expires_at: later }, now), true);
});

test("não segura: vencido, cancelado, Pix no fim do prazo e Pix Aí antigo pendente", () => {
  assert.equal(holdsPlace({ status: "EXPIRED" }, now), false);
  assert.equal(holdsPlace({ status: "CANCELED" }, now), false);
  assert.equal(holdsPlace({ status: "REFUND" }, now), false);
  assert.equal(holdsPlace({ status: "PEDING_PAYMENT", provider: "opapingou", expires_at: earlier }, now), false);
  assert.equal(holdsPlace({ status: "PEDING_PAYMENT", provider: null, expires_at: null }, now), false);
});

test("pickHolder prefere a confirmada à que espera o Pix e ignora as que não seguram", () => {
  const pending = { id: 1, payment: { status: "PEDING_PAYMENT", provider: "opapingou", expires_at: later } };
  const confirmed = { id: 2, payment: { status: "CONFIRMED" } };
  const expired = { id: 3, payment: { status: "EXPIRED" } };
  assert.equal(pickHolder([expired, pending, confirmed], now).id, 2);
  assert.equal(pickHolder([expired, pending], now).id, 1);
  assert.equal(pickHolder([expired], now), null);
  assert.equal(pickHolder([], now), null);
});
