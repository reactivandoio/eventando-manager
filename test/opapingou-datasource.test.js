const test = require("node:test");
const assert = require("node:assert/strict");
const { createOpaPingou, OpaPingouError } = require("../src/datasources/opapingou");

const KEY = "opk_test_fake_key_for_tests";

// Dublê do axios: devolve as respostas em fila e guarda as chamadas.
const fakeHttp = (responses) => {
  const calls = [];
  return {
    calls,
    request: async (config) => {
      calls.push(config);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { headers: {}, ...next };
    },
  };
};

const setup = (responses) => {
  const http = fakeHttp(responses);
  const sleeps = [];
  const lines = [];
  const alerts = [];
  const log = { info: (m) => lines.push(m), error: (m) => lines.push(m) };
  const op = createOpaPingou({
    baseUrl: "https://op.test/",
    apiKey: KEY,
    http,
    sleep: async (ms) => sleeps.push(ms),
    log,
    alert: (m) => alerts.push(m),
  });
  return { op, http, sleeps, lines, alerts };
};

const charge = { id: "ch_1", status: "PENDING", amountCents: 1000, brCode: "000201...", expiresAt: "2026-10-12T00:15:00Z" };
const charge1 = () => ({ ...charge });

test("cria cobrança com Idempotency-Key e corpo estrito, sem bankAccountId", async () => {
  const { op, http } = setup([{ status: 201, data: charge1() }]);
  const r = await op.createCharge({ amountCents: 1000, description: "x".repeat(200), kind: "PIX_QR", idempotencyKey: "signup-payment-7-v1" });
  assert.equal(r.charge.id, "ch_1");
  assert.equal(r.replayed, false);
  const c = http.calls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.url, "https://op.test/v1/charges");
  assert.equal(c.headers["Idempotency-Key"], "signup-payment-7-v1");
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(Object.keys(c.data).sort(), ["amountCents", "description", "kind", "validity"]);
  assert.equal(c.data.validity, "FIFTEEN_MIN");
  assert.equal(c.data.description.length, 140);
});

test("replay: 201 com Idempotent-Replayed devolve a mesma cobrança", async () => {
  const { op } = setup([{ status: 201, data: charge1(), headers: { "Idempotent-Replayed": "true" } }]);
  const r = await op.createCharge({ amountCents: 1000, idempotencyKey: "k" });
  assert.equal(r.replayed, true);
  assert.equal(r.charge.id, "ch_1");
});

for (const [status, code] of [[409, "IDEMPOTENCY_KEY_REUSED"], [400, "IDEMPOTENCY_KEY_REQUIRED"]]) {
  test(`${status} ${code} não repete e chama alert`, async () => {
    const { op, http, alerts } = setup([{ status, data: { code, requestId: "req_9" } }]);
    await assert.rejects(op.createCharge({ amountCents: 1000, idempotencyKey: "k" }), (e) => e instanceof OpaPingouError && e.code === code && e.requestId === "req_9");
    assert.equal(http.calls.length, 1);
    assert.equal(alerts.length, 1);
  });
}

test("401 vira OpaPingouError UNAUTHENTICATED sem repetir", async () => {
  const { op, http } = setup([{ status: 401, data: { code: "UNAUTHENTICATED", requestId: "r" } }]);
  await assert.rejects(op.getCharge("ch_1"), (e) => e.code === "UNAUTHENTICATED" && e.status === 401 && !e.retryable);
  assert.equal(http.calls.length, 1);
});

test("429 espera 1s, 2s, 4s e repete; desiste após 3 repetições", async () => {
  const r429 = () => ({ status: 429, data: { code: "RATE_LIMITED" } });
  const { op, http, sleeps } = setup([r429(), r429(), r429(), r429()]);
  await assert.rejects(op.createCharge({ amountCents: 1000, idempotencyKey: "k" }), (e) => e.code === "RATE_LIMITED" && e.retryable);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.equal(http.calls.length, 4);
});

test("429 com Retry-After respeita o valor", async () => {
  const { op, sleeps } = setup([{ status: 429, data: { code: "RATE_LIMITED" }, headers: { "retry-after": "7" } }, { status: 201, data: charge1() }]);
  await op.createCharge({ amountCents: 1000, idempotencyKey: "k" });
  assert.deepEqual(sleeps, [7000]);
});

test("timeout de rede repete com a mesma chave e devolve a cobrança", async () => {
  const timeout = Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" });
  const { op, http } = setup([timeout, { status: 201, data: charge1(), headers: { "idempotent-replayed": "true" } }]);
  const r = await op.createCharge({ amountCents: 1000, idempotencyKey: "signup-payment-1-v1" });
  assert.equal(r.replayed, true);
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[0].headers["Idempotency-Key"], http.calls[1].headers["Idempotency-Key"]);
});

test("rede fora em todas as tentativas vira NETWORK_ERROR retryable", async () => {
  const e = () => Object.assign(new Error("x"), { code: "ECONNRESET" });
  const { op } = setup([e(), e(), e(), e()]);
  await assert.rejects(op.getCharge("a"), (err) => err.code === "NETWORK_ERROR" && err.retryable);
});

test("PAYMENT_LINK_UNAVAILABLE chega pelo code", async () => {
  const { op } = setup([{ status: 422, data: { code: "PAYMENT_LINK_UNAVAILABLE" } }]);
  await assert.rejects(op.createCharge({ amountCents: 500, kind: "PAYMENT_LINK", idempotencyKey: "k" }), (e) => e.code === "PAYMENT_LINK_UNAVAILABLE");
});

test("valor inválido não chama a API", async () => {
  const { op, http } = setup([]);
  await assert.rejects(op.createCharge({ amountCents: 0, idempotencyKey: "k" }), (e) => e.code === "INVALID_AMOUNT");
  await assert.rejects(op.createCharge({ amountCents: 10.5, idempotencyKey: "k" }), (e) => e.code === "INVALID_AMOUNT");
  assert.equal(http.calls.length, 0);
});

test("log tem code e requestId, nunca a chave; erro não carrega a chave", async () => {
  const { op, lines } = setup([{ status: 500, data: { code: "INTERNAL", requestId: "req_42" } }, { status: 401, data: { code: "UNAUTHENTICATED", requestId: "req_43" } }]);
  const err = await op.getCharge("ch").catch((e) => e);
  assert.ok(lines.some((l) => l.includes("INTERNAL") && l.includes("req_42")));
  assert.ok(lines.every((l) => !l.includes("opk_")));
  assert.ok(!JSON.stringify({ ...err, message: err.message }).includes("opk_"));
});

test("sem chave não chama a API", async () => {
  const http = fakeHttp([]);
  const op = createOpaPingou({ apiKey: "", http, log: { info() {}, error() {} } });
  await assert.rejects(op.me(), (e) => e.code === "API_KEY_MISSING");
  assert.equal(http.calls.length, 0);
});
