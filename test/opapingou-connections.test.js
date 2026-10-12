const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createConnections, ConnectionError, maskCnpj } = require("../src/api/opapingou-connection/services/connections");
const { createSecretBox } = require("../src/utils/secret-box");
const { signOpa } = require("../src/utils/opa-signature");
const { OpaPingouError } = require("../src/datasources/opapingou");

const LIVE_KEY = `opk_live_${"a".repeat(39)}wxyz`;
const LIVE_KEY_2 = `opk_live_${"b".repeat(39)}9876`;
const TEST_KEY = `opk_test_${"c".repeat(39)}tttt`;
const MASTER = crypto.randomBytes(32).toString("base64");
const NOW = new Date("2026-10-12T12:00:00Z");

const company = (id = "co_1") => ({ id, legalName: `Empresa ${id} LTDA`, cnpj: "12345678000190", createdAt: "2026-01-01" });
const me = (co = company()) => ({ id: "u_1", email: "dono@x.test", cpf: "11122233344", phone: "+5562999999999", company: co });

// Banco em memória com a mesma interface do adaptador do Strapi.
const fakeDb = () => {
  const state = { connections: [], events: [], payments: [], seq: 1 };
  const withConn = (e) => e && { ...e, opapingou_connection: state.connections.find((c) => c.id === e.connection_id) || null };
  return {
    state,
    addEvent: (e) => state.events.push({ id: state.seq++, uuid: e.uuid, opapingou_legacy: !!e.legacy, connection_id: null }),
    findEventByUuid: async (uuid) => withConn(state.events.find((e) => e.uuid === uuid)),
    setEventConnection: async (eventId, connectionId, extra = {}) => {
      const e = state.events.find((x) => x.id === eventId);
      e.connection_id = connectionId;
      Object.assign(e, extra);
    },
    findConnectionByPublicId: async (publicId) => state.connections.find((c) => c.public_id === publicId) || null,
    findActiveConnectionByCompany: async (companyId, testMode) =>
      [...state.connections].reverse().find((c) => c.company_id === companyId && c.test_mode === testMode && c.status === "active") || null,
    createConnection: async (data) => {
      const row = { id: state.seq++, createdAt: NOW, ...data };
      state.connections.push(row);
      return row;
    },
    updateConnection: async (id, data) => Object.assign(state.connections.find((c) => c.id === id), data),
    deleteConnection: async (id) => {
      state.connections = state.connections.filter((c) => c.id !== id);
    },
    listConnections: async () =>
      state.connections.map((c) => ({
        ...c,
        events: state.events.filter((e) => e.connection_id === c.id).map((e) => ({ uuid: e.uuid })),
      })),
    countOpenPayments: async (eventId, now) =>
      state.payments.filter((p) => p.event === eventId && p.status === "PEDING_PAYMENT" && p.expires_at > now).length,
  };
};

// Opa Pingou falso: uma "conta" por chave.
const fakeOpa = ({ accounts = {}, endpointLimit = false, createFails = null } = {}) => {
  const calls = [];
  const endpoints = new Map();
  let n = 0;
  const makeClient = (apiKey) => {
    const account = accounts[apiKey];
    const guard = () => {
      if (!account) throw new OpaPingouError({ status: 401, code: "API_KEY_INVALID" });
    };
    return {
      apiKey,
      me: async () => {
        calls.push(["me", apiKey]);
        guard();
        if (account.noProfile) throw new OpaPingouError({ status: 403, code: "INSUFFICIENT_SCOPE" });
        return me(account.company);
      },
      missingScopes: async () => {
        calls.push(["missingScopes", apiKey]);
        guard();
        return account.missing || [];
      },
      createWebhookEndpoint: async (body) => {
        calls.push(["createWebhookEndpoint", apiKey, body]);
        guard();
        if (createFails) throw createFails;
        if (endpointLimit) throw new OpaPingouError({ status: 422, code: "WEBHOOK_ENDPOINT_LIMIT" });
        n += 1;
        const ep = { id: `we_${n}`, url: body.url, status: "ACTIVE", companyId: account.company.id, secret: `whsec_secret_${n}` };
        endpoints.set(ep.id, ep);
        return { ...ep };
      },
      getWebhookEndpoint: async (id) => {
        calls.push(["getWebhookEndpoint", apiKey, id]);
        guard();
        const ep = endpoints.get(id);
        if (!ep || ep.companyId !== account.company.id) throw new OpaPingouError({ status: 404, code: "NOT_FOUND" });
        const { secret, ...rest } = ep;
        return rest;
      },
    };
  };
  return { makeClient, calls, endpoints };
};

const setup = ({ env = {}, opa = fakeOpa({ accounts: { [LIVE_KEY]: { company: company() } } }) } = {}) => {
  const db = fakeDb();
  const lines = [];
  const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  let ids = 0;
  const svc = createConnections({
    db,
    makeClient: opa.makeClient,
    box: createSecretBox({ key: MASTER }),
    env: { OPAPINGOU_WEBHOOK_BASE_URL: "https://bff.test/webhooks/opapingou/", ...env },
    now: () => NOW,
    newPublicId: () => `opc_${(ids += 1)}`,
    log,
  });
  db.addEvent({ uuid: "ev-a" });
  db.addEvent({ uuid: "ev-b" });
  return { svc, db, opa, lines };
};

const noSecretsIn = (value) => {
  const s = JSON.stringify(value);
  for (const bad of [LIVE_KEY, LIVE_KEY_2, TEST_KEY, "whsec_", "key_encrypted", "webhook_secret_encrypted", "11122233344"]) {
    assert.ok(!s.includes(bad), `vazou ${bad}`);
  }
};

test("conecta: valida a chave, cadastra o endpoint com a URL da conexão e liga ao evento", async () => {
  const { svc, db, opa } = setup();
  const summary = await svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "user-1", createdByName: "Ana" });

  assert.deepEqual(summary, {
    id: "opc_1",
    company_name: "Empresa co_1 LTDA",
    company_document: "**.***.***/0001-90",
    test_mode: false,
    key_last4: "wxyz",
    status: "active",
    created_by: "user-1",
    created_by_name: "Ana",
    created_at: NOW.toISOString(),
  });
  noSecretsIn(summary);

  const create = opa.calls.find((c) => c[0] === "createWebhookEndpoint");
  assert.equal(create[2].url, "https://bff.test/webhooks/opapingou/opc_1");
  assert.deepEqual(create[2].events.sort(), [
    "charge.canceled",
    "charge.expired",
    "charge.paid",
    "payment.charged_back",
    "payment.confirmed",
    "payment.refunded",
  ]);

  const row = db.state.connections[0];
  assert.equal(row.webhook_endpoint_id, "we_1");
  assert.equal(row.company_id, "co_1");
  assert.ok(!row.key_encrypted.includes(LIVE_KEY));
  assert.ok(!row.webhook_secret_encrypted.includes("whsec_"));
  assert.equal(db.state.events[0].connection_id, row.id);
  // O que o /v1/me traz de pessoal (CPF, telefone, e-mail) não é guardado.
  noSecretsIn(Object.fromEntries(Object.entries(row).filter(([k]) => !k.endsWith("_encrypted"))));
});

test("a chave e o segredo guardados abrem só para a conexão certa", async () => {
  const { svc, db } = setup();
  await svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" });
  const row = db.state.connections[0];
  const client = svc.clientFor(row);
  assert.equal(client.apiKey, LIVE_KEY);
  // Copiar o cifrado para outra conexão não funciona (AAD = id público + campo).
  assert.throws(() => svc.clientFor({ ...row, public_id: "opc_outra" }));
});

test("formato inválido: recusa sem chamar o Opa Pingou", async () => {
  const { svc, opa } = setup();
  for (const apiKey of ["", "abc", "opk_live_", "sk_live_123", `opk_live_${"a".repeat(10)} x`]) {
    await assert.rejects(svc.connect({ eventUuid: "ev-a", apiKey, createdBy: "u" }), (e) => e.code === "INVALID_KEY_FORMAT");
  }
  assert.equal(opa.calls.length, 0);
});

test("chave de teste só com OPAPINGOU_ACCEPT_TEST_MODE=true", async () => {
  const opa = fakeOpa({ accounts: { [TEST_KEY]: { company: company("co_t") } } });
  const off = setup({ opa });
  await assert.rejects(off.svc.connect({ eventUuid: "ev-a", apiKey: TEST_KEY, createdBy: "u" }), (e) => e.code === "TEST_KEY_NOT_ALLOWED");
  assert.equal(opa.calls.length, 0);

  const on = setup({ opa, env: { OPAPINGOU_ACCEPT_TEST_MODE: "true" } });
  const s = await on.svc.connect({ eventUuid: "ev-a", apiKey: TEST_KEY, createdBy: "u" });
  assert.equal(s.test_mode, true);
});

test("chave recusada, sem empresa ou sem escopos: erro claro e nada gravado", async () => {
  const opa = fakeOpa({
    accounts: {
      [LIVE_KEY]: { company: null },
      [LIVE_KEY_2]: { company: company(), missing: ["charges:write", "webhooks:read"] },
    },
  });
  const { svc, db } = setup({ opa });
  await assert.rejects(
    svc.connect({ eventUuid: "ev-a", apiKey: `opk_live_${"z".repeat(43)}`, createdBy: "u" }),
    (e) => e.code === "INVALID_KEY"
  );
  await assert.rejects(svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" }), (e) => e.code === "NO_COMPANY");
  await assert.rejects(
    svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY_2, createdBy: "u" }),
    (e) => e.code === "MISSING_SCOPES" && e.extra.missing.join() === "charges:write,webhooks:read"
  );
  assert.equal(db.state.connections.length, 0);
  assert.equal(db.state.events[0].connection_id, null);
});

test("sem profile:read: MISSING_SCOPES com profile:read", async () => {
  const opa = fakeOpa({ accounts: { [LIVE_KEY]: { company: company(), noProfile: true } } });
  const { svc } = setup({ opa });
  await assert.rejects(
    svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" }),
    (e) => e.code === "MISSING_SCOPES" && e.extra.missing.includes("profile:read")
  );
});

test("limite de 10 endpoints: ENDPOINT_LIMIT e a conexão provisória some", async () => {
  const opa = fakeOpa({ accounts: { [LIVE_KEY]: { company: company() } }, endpointLimit: true });
  const { svc, db } = setup({ opa });
  await assert.rejects(svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" }), (e) => e.code === "ENDPOINT_LIMIT");
  assert.equal(db.state.connections.length, 0);
});

test("falta webhooks:write no cadastro do endpoint: MISSING_SCOPES", async () => {
  const opa = fakeOpa({
    accounts: { [LIVE_KEY]: { company: company() } },
    createFails: new OpaPingouError({ status: 403, code: "INSUFFICIENT_SCOPE" }),
  });
  const { svc, db } = setup({ opa });
  await assert.rejects(
    svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" }),
    (e) => e.code === "MISSING_SCOPES" && e.extra.missing.join() === "webhooks:write"
  );
  assert.equal(db.state.connections.length, 0);
});

test("Opa Pingou fora do ar: OPAPINGOU_UNAVAILABLE", async () => {
  const opa = fakeOpa({
    accounts: { [LIVE_KEY]: { company: company() } },
    createFails: new OpaPingouError({ status: null, code: "NETWORK_ERROR", retryable: true }),
  });
  const { svc } = setup({ opa });
  await assert.rejects(svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" }), (e) => e.code === "OPAPINGOU_UNAVAILABLE");
});

test("mesma empresa em outro evento: reaproveita a conexão e o endpoint, troca a chave", async () => {
  const opa = fakeOpa({ accounts: { [LIVE_KEY]: { company: company() }, [LIVE_KEY_2]: { company: company() } } });
  const { svc, db } = setup({ opa });
  await svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u1" });
  const s = await svc.connect({ eventUuid: "ev-b", apiKey: LIVE_KEY_2, createdBy: "u2" });

  assert.equal(s.id, "opc_1");
  assert.equal(s.key_last4, "9876");
  assert.equal(opa.calls.filter((c) => c[0] === "createWebhookEndpoint").length, 1);
  assert.equal(db.state.connections.length, 1);
  assert.equal(db.state.events[1].connection_id, db.state.connections[0].id);
  assert.equal(svc.clientFor(db.state.connections[0]).apiKey, LIVE_KEY_2);
});

test("mesma empresa mas o endpoint antigo sumiu: cria conexão nova", async () => {
  const opa = fakeOpa({ accounts: { [LIVE_KEY]: { company: company() } } });
  const { svc, db } = setup({ opa });
  await svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" });
  opa.endpoints.clear();
  const s = await svc.connect({ eventUuid: "ev-b", apiKey: LIVE_KEY, createdBy: "u" });
  assert.equal(s.id, "opc_2");
  assert.equal(db.state.connections.length, 2);
  // O próximo evento da mesma empresa reaproveita a mais nova, não cria uma terceira.
  db.addEvent({ uuid: "ev-c" });
  const again = await svc.connect({ eventUuid: "ev-c", apiKey: LIVE_KEY, createdBy: "u" });
  assert.equal(again.id, "opc_2");
  assert.equal(db.state.connections.length, 2);
});

test("evento inexistente: EVENT_NOT_FOUND antes de chamar o Opa Pingou", async () => {
  const { svc, opa } = setup();
  await assert.rejects(svc.connect({ eventUuid: "nao-existe", apiKey: LIVE_KEY, createdBy: "u" }), (e) => e.code === "EVENT_NOT_FOUND");
  assert.equal(opa.calls.length, 0);
});

test("forEvent: conexão do evento, legado ou nada", async () => {
  const { svc, db } = setup();
  db.addEvent({ uuid: "ev-legado", legacy: true });
  assert.deepEqual(await svc.forEvent("ev-a"), { connection: null, legacy: false });
  assert.deepEqual(await svc.forEvent("ev-legado"), { connection: null, legacy: true });
  await svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" });
  const r = await svc.forEvent("ev-a");
  assert.equal(r.connection.id, "opc_1");
  noSecretsIn(r);
  await assert.rejects(svc.forEvent("x"), (e) => e.code === "EVENT_NOT_FOUND");
});

test("attach: liga uma conexão existente a outro evento; conexão inexistente é 404", async () => {
  const { svc, db } = setup();
  await svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" });
  const s = await svc.attach({ eventUuid: "ev-b", publicId: "opc_1" });
  assert.equal(s.id, "opc_1");
  assert.equal(db.state.events[1].connection_id, db.state.connections[0].id);
  await assert.rejects(svc.attach({ eventUuid: "ev-b", publicId: "opc_x" }), (e) => e.code === "CONNECTION_NOT_FOUND");
});

test("detach: bloqueado com pagamento em aberto; depois solta o evento e tira o legado", async () => {
  const { svc, db } = setup();
  await svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" });
  const ev = db.state.events[0];
  ev.opapingou_legacy = true;
  db.state.payments.push({ event: ev.id, status: "PEDING_PAYMENT", expires_at: new Date(NOW.getTime() + 60000) });
  await assert.rejects(svc.detach({ eventUuid: "ev-a" }), (e) => e.code === "PENDING_PAYMENTS" && e.extra.count === 1);

  db.state.payments[0].expires_at = new Date(NOW.getTime() - 1);
  await svc.detach({ eventUuid: "ev-a" });
  assert.equal(ev.connection_id, null);
  assert.equal(ev.opapingou_legacy, false);
});

test("list: resumos com os eventos de cada conexão, sem segredo", async () => {
  const { svc } = setup();
  await svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u1" });
  const list = await svc.list();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].event_uuids, ["ev-a"]);
  noSecretsIn(list);
});

test("verifyWebhook: assinatura com o segredo da conexão vale; de outra conexão não", async () => {
  const opa = fakeOpa({ accounts: { [LIVE_KEY]: { company: company("co_1") }, [LIVE_KEY_2]: { company: company("co_2") } } });
  const { svc } = setup({ opa });
  await svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" });
  await svc.connect({ eventUuid: "ev-b", apiKey: LIVE_KEY_2, createdBy: "u" });
  const rawBody = Buffer.from(JSON.stringify({ id: "evt_1", type: "charge.paid" }));
  const t = Math.floor(NOW.getTime() / 1000);
  const sig1 = signOpa({ rawBody, secret: "whsec_secret_1", t });

  assert.deepEqual(await svc.verifyWebhook({ publicId: "opc_1", rawBody, signature: sig1, nowS: t }), {
    found: true,
    valid: true,
    test_mode: false,
  });
  // A assinatura da empresa 1 não vale na URL da empresa 2.
  const cross = await svc.verifyWebhook({ publicId: "opc_2", rawBody, signature: sig1, nowS: t });
  assert.equal(cross.valid, false);
  assert.equal(cross.reason, "mismatch");
  // Corpo alterado ou atrasado.
  assert.equal((await svc.verifyWebhook({ publicId: "opc_1", rawBody: Buffer.from("{}"), signature: sig1, nowS: t })).valid, false);
  assert.equal((await svc.verifyWebhook({ publicId: "opc_1", rawBody, signature: sig1, nowS: t + 301 })).reason, "stale");
  // Conexão desconhecida.
  assert.deepEqual(await svc.verifyWebhook({ publicId: "opc_9", rawBody, signature: sig1, nowS: t }), { found: false, valid: false });
});

test("chargeConnectionFor: conexão ativa, legado com chave global, ou nada", () => {
  const { svc } = setup({ env: { OPAPINGOU_API_KEY: "x" } });
  assert.deepEqual(svc.chargeConnectionFor({ opapingou_connection: { id: 7, status: "active" } }), { connectionId: 7 });
  assert.deepEqual(svc.chargeConnectionFor({ opapingou_connection: null, opapingou_legacy: true }), { connectionId: null });
  assert.equal(svc.chargeConnectionFor({ opapingou_connection: null, opapingou_legacy: false }), null);
  assert.equal(svc.chargeConnectionFor({ opapingou_connection: { id: 7, status: "pending" } }), null);

  const noGlobal = setup();
  assert.equal(noGlobal.svc.chargeConnectionFor({ opapingou_connection: null, opapingou_legacy: true }), null);
});

test("clientFor(null) usa a chave global (pagamentos antigos e eventos legados)", () => {
  const calls = [];
  const svc = createConnections({
    db: fakeDb(),
    makeClient: (k) => (calls.push(k), { k }),
    box: createSecretBox({ key: MASTER }),
    env: {},
  });
  svc.clientFor(null);
  assert.deepEqual(calls, [undefined]);
});

test("nenhuma linha de log carrega chave, segredo ou CPF", async () => {
  const { svc, lines } = setup();
  await svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" });
  await assert.rejects(svc.connect({ eventUuid: "ev-a", apiKey: `opk_live_${"q".repeat(43)}`, createdBy: "u" }));
  noSecretsIn(lines);
});

test("maskCnpj", () => {
  assert.equal(maskCnpj("12345678000190"), "**.***.***/0001-90");
  assert.equal(maskCnpj("12.345.678/0001-90"), "**.***.***/0001-90");
  assert.equal(maskCnpj("123"), null);
  assert.equal(maskCnpj(null), null);
});

test("ConnectionError tem status HTTP e mensagem para a pessoa", () => {
  const e = new ConnectionError("ENDPOINT_LIMIT");
  assert.equal(e.status, 409);
  assert.match(e.userMessage, /10/);
});

test("sem chave mestra: NOT_CONFIGURED antes de chamar o Opa Pingou", async () => {
  const opa = fakeOpa({ accounts: { [LIVE_KEY]: { company: company() } } });
  const db = fakeDb();
  db.addEvent({ uuid: "ev-a" });
  const svc = createConnections({ db, makeClient: opa.makeClient, box: createSecretBox({ key: "" }), env: {} });
  await assert.rejects(svc.connect({ eventUuid: "ev-a", apiKey: LIVE_KEY, createdBy: "u" }), (e) => e.code === "NOT_CONFIGURED" && e.status === 503);
  assert.equal(opa.calls.length, 0);
});
