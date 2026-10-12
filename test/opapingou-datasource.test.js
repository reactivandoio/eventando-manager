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

// ---------- prazo total (504 da primeira inscrição paga em produção) ----------

// Relógio falso: o http "trava" até o timeout pedido e o sleep só avança o relógio.
const clockSetup = (behaviours, { deadlineMs = 40000, timeout = 15000 } = {}) => {
  let t = 0;
  const calls = [];
  const http = {
    request: async (config) => {
      calls.push(config);
      const b = behaviours.shift() || "hang";
      if (b === "hang") {
        t += config.timeout;
        throw Object.assign(new Error(`timeout of ${config.timeout}ms exceeded`), { code: "ECONNABORTED" });
      }
      t += b.ms || 100;
      return { headers: {}, ...b.res };
    },
  };
  const op = createOpaPingou({
    apiKey: KEY,
    http,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    log: { info() {}, error() {} },
    alert() {},
    deadlineMs,
    timeout,
  });
  return { op, calls, elapsed: () => t };
};

test("Opa Pingou sem responder: desiste dentro do prazo total (antes dos 60 s do proxy)", async () => {
  const { op, elapsed, calls } = clockSetup(["hang", "hang", "hang", "hang"]);
  await assert.rejects(
    op.createCharge({ amountCents: 1990, idempotencyKey: "signup-payment-1-v1" }),
    (e) => e.code === "DEADLINE_EXCEEDED" && e.retryable
  );
  assert.ok(elapsed() <= 40000, `levou ${elapsed()} ms`);
  assert.ok(calls.every((c) => c.headers["Idempotency-Key"] === "signup-payment-1-v1"));
});

test("sem o prazo, o mesmo caso passaria de 60 s (o que gerou o 504)", async () => {
  const { op, elapsed } = clockSetup(["hang", "hang", "hang", "hang"], { deadlineMs: 10 ** 9 });
  await assert.rejects(op.createCharge({ amountCents: 1990, idempotencyKey: "k" }));
  assert.ok(elapsed() > 60000, `levou ${elapsed()} ms`);
});

test("lento na primeira, responde na segunda: devolve a cobrança dentro do prazo", async () => {
  const { op, elapsed } = clockSetup(["hang", { ms: 3000, res: { status: 201, data: { id: "ch_9" }, headers: { "idempotent-replayed": "true" } } }]);
  const r = await op.createCharge({ amountCents: 1990, idempotencyKey: "k" });
  assert.equal(r.charge.id, "ch_9");
  assert.equal(r.replayed, true);
  assert.ok(elapsed() <= 40000);
});

test("429 com Retry-After maior que o tempo restante não espera: devolve erro repetível", async () => {
  const { op, elapsed } = clockSetup([{ ms: 100, res: { status: 429, data: { code: "RATE_LIMITED" }, headers: { "retry-after": "30" } } }], { deadlineMs: 20000 });
  await assert.rejects(op.createCharge({ amountCents: 1990, idempotencyKey: "k" }), (e) => e.code === "RATE_LIMITED" && e.retryable);
  assert.ok(elapsed() < 1000);
});

test("cada tentativa usa no máximo o tempo que sobra do prazo", async () => {
  const { op, calls } = clockSetup(["hang", "hang", "hang"], { deadlineMs: 20000, timeout: 15000 });
  await assert.rejects(op.createCharge({ amountCents: 1990, idempotencyKey: "k" }));
  assert.equal(calls[0].timeout, 15000);
  assert.ok(calls[1].timeout <= 20000 - 15000 - 1000);
});
