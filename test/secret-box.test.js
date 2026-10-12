const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createSecretBox, SecretBoxError } = require("../src/utils/secret-box");

const KEY = crypto.randomBytes(32).toString("base64");
const OTHER = crypto.randomBytes(32).toString("base64");

test("sela e abre com a mesma chave e o mesmo contexto", () => {
  const box = createSecretBox({ key: KEY });
  const sealed = box.seal("opk_test_abc", "conn_1:api_key");
  assert.match(sealed, /^v1\./);
  assert.ok(!sealed.includes("opk_test_abc"));
  assert.equal(box.open(sealed, "conn_1:api_key"), "opk_test_abc");
});

test("cada selagem usa um IV novo", () => {
  const box = createSecretBox({ key: KEY });
  assert.notEqual(box.seal("x", "c"), box.seal("x", "c"));
});

test("contexto diferente não abre (o segredo fica preso à conexão e ao campo)", () => {
  const box = createSecretBox({ key: KEY });
  const sealed = box.seal("whsec_1", "conn_1:webhook_secret");
  assert.throws(() => box.open(sealed, "conn_2:webhook_secret"), SecretBoxError);
  assert.throws(() => box.open(sealed, "conn_1:api_key"), SecretBoxError);
});

test("chave mestra diferente não abre", () => {
  const sealed = createSecretBox({ key: KEY }).seal("x", "c");
  assert.throws(() => createSecretBox({ key: OTHER }).open(sealed, "c"), SecretBoxError);
});

test("texto adulterado não abre", () => {
  const box = createSecretBox({ key: KEY });
  const parts = box.seal("segredo", "c").split(".");
  const ct = Buffer.from(parts[3], "base64url");
  ct[0] ^= 1;
  parts[3] = ct.toString("base64url");
  assert.throws(() => box.open(parts.join("."), "c"), SecretBoxError);
});

test("sem chave mestra (ou com tamanho errado): erro sem expor nada", () => {
  assert.throws(() => createSecretBox({ key: "" }).seal("x", "c"), (err) => err.code === "CREDENTIALS_KEY_MISSING");
  assert.throws(
    () => createSecretBox({ key: Buffer.alloc(16).toString("base64") }).seal("x", "c"),
    (err) => err.code === "CREDENTIALS_KEY_INVALID"
  );
});

test("a mensagem de erro nunca traz o texto aberto", () => {
  const box = createSecretBox({ key: KEY });
  try {
    box.open("v1.lixo", "c");
    assert.fail("deveria falhar");
  } catch (err) {
    assert.ok(err instanceof SecretBoxError);
    assert.ok(!String(err.message).includes("lixo"));
  }
});
