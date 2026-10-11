const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCpf } = require("../src/utils/cpf");

test("aceita CPF válido com ou sem máscara", () => {
  assert.equal(normalizeCpf("529.982.247-25"), "52998224725");
  assert.equal(normalizeCpf(" 52998224725 "), "52998224725");
  assert.equal(normalizeCpf("529 982 247 25"), "52998224725");
});

test("recusa dígito verificador errado, tamanho errado e repetidos", () => {
  assert.equal(normalizeCpf("529.982.247-24"), null);
  assert.equal(normalizeCpf("5299822472"), null);
  assert.equal(normalizeCpf("529982247255"), null);
  assert.equal(normalizeCpf("111.111.111-11"), null);
  assert.equal(normalizeCpf(null), null);
  assert.equal(normalizeCpf(undefined), null);
  assert.equal(normalizeCpf(""), null);
});
