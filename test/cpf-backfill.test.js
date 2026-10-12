const test = require("node:test");
const assert = require("node:assert/strict");
const { planBackfill } = require("../src/utils/cpf-backfill");

const VALID_A = "52998224725";
const VALID_B = "11144477735";

test("só preenche CPF vazio", () => {
  const r = planBackfill([{ id: 1, email: "a@x.com", cpf: VALID_B }], [{ email: "a@x.com", cpf: VALID_A }], []);
  assert.deepEqual(r.updates, []);
  assert.equal(r.skipped.alreadySet, 1);
});

test("e-mail comparado sem caixa e sem espaços; aceita CPF com máscara", () => {
  const r = planBackfill([{ id: 2, email: " Ana@X.com " }], [{ email: "ana@x.COM", cpf: "529.982.247-25" }], []);
  assert.deepEqual(r.updates, [{ id: 2, cpf: VALID_A }]);
});

test("CPF inválido é pulado e contado", () => {
  const r = planBackfill([{ id: 3, email: "b@x.com" }], [{ email: "b@x.com", cpf: "123" }], []);
  assert.deepEqual(r.updates, []);
  assert.equal(r.skipped.invalid, 1);
});

test("conta do Hub vence o sw-form; sem nada, noMatch", () => {
  const r = planBackfill(
    [{ id: 4, email: "c@x.com" }, { id: 5, email: "d@x.com" }],
    [{ email: "c@x.com", cpf: VALID_A }],
    [{ email: "c@x.com", cpf: VALID_B }]
  );
  assert.deepEqual(r.updates, [{ id: 4, cpf: VALID_A }]);
  assert.equal(r.skipped.noMatch, 1);
});

test("sem conta, usa o sw-form", () => {
  const r = planBackfill([{ id: 6, email: "e@x.com" }], [], [{ email: "e@x.com", cpf: VALID_B }]);
  assert.deepEqual(r.updates, [{ id: 6, cpf: VALID_B }]);
});
