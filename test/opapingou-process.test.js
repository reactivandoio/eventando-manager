const test = require("node:test");
const assert = require("node:assert/strict");
const { createProcessor, chargeIdOf } = require("../src/api/opapingou-event/services/process");

// Banco em memória com a mesma interface do adaptador do Strapi.
const memoryDb = ({ events = [], payments = [] }) => {
  const db = {
    events: events.map((e, i) => ({ id: i + 1, status: "pending", attempts: 0, ...e })),
    payments: payments.map((p) => ({ ...p })),
    findEvent: async (eventId) => db.events.find((e) => e.event_id === eventId) || null,
    updateEvent: async (id, data) => Object.assign(db.events.find((e) => e.id === id), data),
    findPaymentByCharge: async (cid) =>
      db.payments.find((p) => p.provider_charge_id === cid) ||
      db.payments.find((p) => String(p.previous_charge_ids || "").split(",").includes(cid)) ||
      null,
    transition: async (id, from, data) => {
      const p = db.payments.find((x) => x.id === id && from.includes(x.status));
      if (!p) return 0;
      Object.assign(p, data);
      return 1;
    },
    getPayment: async (id) => db.payments.find((p) => p.id === id) || null,
  };
  return db;
};

const setup = ({ events, payments, charges = {}, env = {} }) => {
  const db = memoryDb({ events, payments });
  const alerts = [];
  const lookups = [];
  const opapingou = {
    getCharge: async (id) => {
      lookups.push(id);
      const c = charges[id];
      if (c instanceof Error) throw c;
      return c;
    },
  };
  const warns = [];
  const log = { error: (m) => alerts.push(m), warn: (m) => warns.push(m), info() {} };
  const run = createProcessor({ db, opapingou, log, env });
  return { db, run, alerts, lookups, warns };
};

const pending = (over = {}) => ({
  id: 7,
  status: "PEDING_PAYMENT",
  value: 1000,
  provider_charge_id: "ch_1",
  signup: { id: 3, name: "Ana", email: "a@x.com", phone_number: "1" },
  event: { id: 2, uuid: "u", slug: "ev" },
  ...over,
});
const ev = (over = {}) => ({ event_id: "evt_1", type: "charge.paid", charge_id: "ch_1", ...over });

test("charge.paid reconsulta e confirma; processar de novo não transiciona", async () => {
  const { run, db, lookups } = setup({ events: [ev()], payments: [pending()], charges: { ch_1: { status: "PAID" } } });
  const first = await run("evt_1");
  assert.equal(first.httpStatus, 200);
  assert.equal(first.body.transitioned, true);
  assert.equal(first.body.status, "CONFIRMED");
  assert.deepEqual(first.body.payment.signup, { id: 3, name: "Ana", email: "a@x.com", phone_number: "1" });
  assert.deepEqual(first.body.payment.event, { id: 2, uuid: "u", slug: "ev" });
  assert.ok(db.payments[0].confirmed_at);
  const second = await run("evt_1");
  assert.equal(second.body.transitioned, false);
  assert.equal(second.body.status, "CONFIRMED");
  assert.deepEqual(lookups, ["ch_1", "ch_1"]);
});

test("nunca libera pelo corpo: cobrança ainda PENDING não confirma", async () => {
  const { run, db } = setup({ events: [ev()], payments: [pending()], charges: { ch_1: { status: "PENDING" } } });
  const r = await run("evt_1");
  assert.equal(r.body.transitioned, false);
  assert.equal(db.payments[0].status, "PEDING_PAYMENT");
});

test("expired depois de paid: continua CONFIRMED", async () => {
  const { run, db } = setup({
    events: [ev({ event_id: "evt_2", type: "charge.expired" })],
    payments: [pending({ status: "CONFIRMED" })],
    charges: { ch_1: { status: "EXPIRED" } },
  });
  const r = await run("evt_2");
  assert.equal(r.body.transitioned, false);
  assert.equal(db.payments[0].status, "CONFIRMED");
});

test("Pix pago depois de vencer é honrado", async () => {
  const { run, db } = setup({ events: [ev()], payments: [pending({ status: "EXPIRED" })], charges: { ch_1: { status: "PAID" } } });
  assert.equal((await run("evt_1")).body.transitioned, true);
  assert.equal(db.payments[0].status, "CONFIRMED");
});

test("cobrança desconhecida: 404 e evento ignored", async () => {
  const { run, db, lookups } = setup({ events: [ev({ charge_id: "ch_x" })], payments: [pending()] });
  const r = await run("evt_1");
  assert.equal(r.httpStatus, 404);
  assert.equal(db.events[0].status, "ignored");
  assert.deepEqual(lookups, []);
});

test("cobrança de tentativa anterior: paga confirma e alerta; vencida não mexe na atual", async () => {
  const p = pending({ provider_charge_id: "ch_2", previous_charge_ids: "ch_1" });
  const exp = setup({ events: [ev({ type: "charge.expired" })], payments: [p], charges: { ch_1: { status: "EXPIRED" } } });
  await exp.run("evt_1");
  assert.equal(exp.db.payments[0].status, "PEDING_PAYMENT");
  const paid = setup({ events: [ev()], payments: [p], charges: { ch_1: { status: "PAID" } } });
  assert.equal((await paid.run("evt_1")).body.transitioned, true);
  assert.ok(paid.alerts.some((m) => m.includes("[ALERTA]")));
});

test("refunded e charged_back: só registra e alerta", async () => {
  for (const type of ["payment.refunded", "payment.charged_back"]) {
    const { run, db, alerts, lookups } = setup({ events: [ev({ type })], payments: [pending({ status: "CONFIRMED" })] });
    const r = await run("evt_1");
    assert.equal(r.body.alert, true);
    assert.equal(db.events[0].status, "ignored");
    assert.equal(db.payments[0].status, "CONFIRMED");
    assert.equal(lookups.length, 0);
    assert.ok(alerts.length > 0);
  }
});

test("testMode é ignorado sem OPAPINGOU_ACCEPT_TEST_MODE", async () => {
  const off = setup({ events: [ev({ test_mode: true })], payments: [pending()], charges: { ch_1: { status: "PAID" } } });
  assert.equal((await off.run("evt_1")).body.reason, "test_mode");
  assert.equal(off.db.payments[0].status, "PEDING_PAYMENT");
  const on = setup({ events: [ev({ test_mode: true })], payments: [pending()], charges: { ch_1: { status: "PAID" } }, env: { OPAPINGOU_ACCEPT_TEST_MODE: "true" } });
  assert.equal((await on.run("evt_1")).body.transitioned, true);
});

test("ping e tipos não tratados: 200 ignorado", async () => {
  const { run } = setup({ events: [ev({ type: "ping", charge_id: null }), ev({ event_id: "e2", type: "bank_account.updated" })] });
  assert.equal((await run("evt_1")).body.reason, "type_not_handled");
  assert.equal((await run("e2")).httpStatus, 200);
});

test("falha na reconsulta: 502, tentativas contadas, failed depois de 10", async () => {
  const err = Object.assign(new Error("x"), { code: "NETWORK_ERROR" });
  const { run, db, alerts } = setup({ events: [ev()], payments: [pending()], charges: { ch_1: err } });
  const r = await run("evt_1");
  assert.equal(r.httpStatus, 502);
  assert.equal(db.events[0].attempts, 1);
  assert.equal(db.events[0].status, "pending");
  db.events[0].attempts = 9;
  await run("evt_1");
  assert.equal(db.events[0].status, "failed");
  assert.ok(alerts.some((m) => m.includes("[ALERTA]")));
});

test("evento inexistente: 404", async () => {
  const { run } = setup({ events: [] });
  assert.equal((await run("nada")).httpStatus, 404);
});

test("id da cobrança vem do campo ou do payload", () => {
  assert.equal(chargeIdOf({ charge_id: "a" }), "a");
  assert.equal(chargeIdOf({ payload: { data: { type: "charge", object: { id: "b" } } } }), "b");
  assert.equal(chargeIdOf({ payload: { data: { type: "payment", object: { id: "p", chargeId: "c" } } } }), "c");
  assert.equal(chargeIdOf({ payload: { data: { type: "payment", object: { id: "p" } } } }), null);
});

test("REA-12: reconsulta pela conta do webhook (opapingouFor recebe o evento gravado)", async () => {
  const db = memoryDb({ events: [ev({ connection: { id: 5, public_id: "opc_5" } })], payments: [pending()] });
  const seen = [];
  const run = createProcessor({
    db,
    opapingouFor: (row) => {
      seen.push(row.connection && row.connection.public_id);
      return { getCharge: async () => ({ status: "PAID" }) };
    },
    log: { error() {}, info() {} },
    env: {},
  });
  const r = await run("evt_1");
  assert.equal(r.body.transitioned, true);
  assert.deepEqual(seen, ["opc_5"]);
});

test("REA-12: cobrança que não é da conta do webhook (404): ignora e alerta, sem repetir", async () => {
  const notFound = Object.assign(new Error("404"), { status: 404, code: "NOT_FOUND" });
  const { run, db, alerts } = setup({ events: [ev()], payments: [pending()], charges: { ch_1: notFound } });
  const r = await run("evt_1");
  assert.equal(r.httpStatus, 200);
  assert.equal(r.body.reason, "charge_not_in_account");
  assert.equal(db.events[0].status, "ignored");
  assert.equal(db.payments[0].status, "PEDING_PAYMENT");
  assert.ok(alerts.some((m) => m.includes("ch_1")));
});

const notFound = () => Object.assign(new Error("404"), { status: 404, code: "NOT_FOUND" });

test("REA-12: 404 na conta do webhook e o pagamento é de outra conta: reconsulta pela conta do pagamento", async () => {
  const db = memoryDb({
    events: [ev({ connection: { id: 5 } })],
    payments: [pending({ opapingou_connection: { id: 9 } })],
  });
  const asked = [];
  const run = createProcessor({
    db,
    opapingouFor: () => ({ getCharge: async () => { asked.push("webhook"); throw notFound(); } }),
    opapingouForPayment: (p) => ({ getCharge: async () => { asked.push(`payment:${p.opapingou_connection.id}`); return { status: "PAID" }; } }),
    log: { error() {}, info() {} },
    env: {},
  });
  const r = await run("evt_1");
  assert.equal(r.body.transitioned, true);
  assert.deepEqual(asked, ["webhook", "payment:9"]);
});

test("REA-12: mesma conta no webhook e no pagamento: 404 não tenta de novo", async () => {
  const db = memoryDb({ events: [ev({ connection: { id: 5 } })], payments: [pending({ opapingou_connection: { id: 5 } })] });
  let second = 0;
  const run = createProcessor({
    db,
    opapingouFor: () => ({ getCharge: async () => { throw notFound(); } }),
    opapingouForPayment: () => ({ getCharge: async () => { second += 1; return { status: "PAID" }; } }),
    log: { error() {}, info() {} },
    env: {},
  });
  const r = await run("evt_1");
  assert.equal(r.body.reason, "charge_not_in_account");
  assert.equal(second, 0);
});

// REA-34: webhook depois de uma aprovação manual nunca desfaz a aprovação e fica no log.
const APPROVED_AT = new Date("2026-11-10T10:00:00Z");
const APPROVER = { id: "42", email: "admin@x.com", name: "Admin" };
const approved = () =>
  pending({ status: "CONFIRMED", confirmed_at: APPROVED_AT, manual_approved_at: APPROVED_AT, manual_approved_by: APPROVER });

for (const [type, chargeStatus] of [
  ["charge.expired", "EXPIRED"],
  ["charge.canceled", "CANCELED"],
  ["charge.paid", "PAID"],
]) {
  test(`${type} depois de aprovação manual: não transiciona, segue CONFIRMED e loga`, async () => {
    const { run, db, warns } = setup({
      events: [ev({ type })],
      payments: [approved()],
      charges: { ch_1: { status: chargeStatus } },
    });
    const r = await run("evt_1");
    assert.equal(r.httpStatus, 200);
    assert.equal(r.body.transitioned, false);
    assert.equal(r.body.status, "CONFIRMED");
    // O BFF usa este campo para o próprio log e para não mandar e-mail.
    assert.equal(r.body.payment.manual_approved_at, APPROVED_AT);
    const p = db.payments[0];
    assert.equal(p.status, "CONFIRMED");
    assert.equal(p.confirmed_at, APPROVED_AT);
    assert.equal(p.manual_approved_at, APPROVED_AT);
    assert.deepEqual(p.manual_approved_by, APPROVER);
    assert.equal(p.expired_at, undefined);
    assert.equal(p.canceled_at, undefined);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /^\[opapingou\] pagamento 7 aprovado manualmente; /);
    assert.ok(warns[0].includes(`${type}/${chargeStatus} ignorado`));
    if (chargeStatus === "PAID") assert.match(warns[0], /entrou dinheiro/);
  });
}

test("webhook sem aprovação manual não gera o aviso", async () => {
  const { run, warns } = setup({
    events: [ev({ type: "charge.expired" })],
    payments: [pending({ status: "CONFIRMED" })],
    charges: { ch_1: { status: "EXPIRED" } },
  });
  await run("evt_1");
  assert.deepEqual(warns, []);
});
