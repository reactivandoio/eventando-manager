const test = require("node:test");
const assert = require("node:assert/strict");
const { createManualApproval, isActive } = require("../src/api/payment/services/manual-approval");

// Banco em memória com a mesma interface do adaptador do Strapi.
const memoryDb = ({ signups = [], payments = [] }) => {
  const db = {
    signups: signups.map((s) => ({ ...s })),
    payments: payments.map((p) => ({ ...p })),
    approveCalls: 0,
    findSignup: async (id) => {
      const s = db.signups.find((x) => x.id === id);
      if (!s) return null;
      const payment = s.payment_id ? db.payments.find((p) => p.id === s.payment_id) || null : null;
      return { ...s, payment };
    },
    countActive: async ({ batch, event, coupon, exceptPaymentId }) =>
      db.payments.filter(
        (p) =>
          isActive(p) &&
          p.id !== exceptPaymentId &&
          (batch === undefined || p.batch_id === batch) &&
          (event === undefined || p.event_id === event) &&
          (coupon === undefined || p.coupon_id === coupon)
      ).length,
    approve: async (id, from, data) => {
      db.approveCalls += 1;
      const p = db.payments.find((x) => x.id === id && from.includes(x.status));
      if (!p) return 0;
      Object.assign(p, data);
      return 1;
    },
    getPayment: async (id) => db.payments.find((p) => p.id === id) || null,
  };
  return db;
};

const NOW = new Date("2026-11-11T12:00:00Z");
const EVENT = { id: 2, uuid: "u-2", slug: "ev", max_slots: null };
const ADMIN = { id: "42", email: "admin@x.com", name: "Admin" };

const payment = (over = {}) => ({
  id: 7,
  status: "EXPIRED",
  value: 5000,
  original_value: 5000,
  expires_at: new Date("2026-11-10T00:00:00Z"),
  event_id: 2,
  batch_id: 11,
  coupon_id: null,
  batch: { id: 11, max_quantity: null },
  coupon: null,
  manual_approved_at: null,
  manual_approved_by: null,
  ...over,
});
const signup = (over = {}) => ({
  id: 3,
  name: "Ana",
  email: "ana@x.com",
  phone_number: "11999",
  cpf: "12345678909",
  event: EVENT,
  payment_id: 7,
  ...over,
});
// Outras inscrições ativas que ocupam vaga / usam cupom.
const others = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: 100 + i,
    status: "CONFIRMED",
    event_id: 2,
    batch_id: 11,
    coupon_id: null,
    ...over,
  }));

const setup = ({ signups = [signup()], payments = [payment()] } = {}) => {
  const db = memoryDb({ signups, payments });
  const warns = [];
  const svc = createManualApproval({ db, log: { warn: (m) => warns.push(m), info() {} }, now: () => NOW });
  return { db, svc, warns };
};

// ---------- preview ----------

test("preview: EXPIRED, CANCELED e PEDING_PAYMENT são aprováveis", async () => {
  for (const status of ["EXPIRED", "CANCELED", "PEDING_PAYMENT"]) {
    const { svc } = setup({ payments: [payment({ status })] });
    const r = await svc.preview({ eventId: 2, signupId: 3 });
    assert.deepEqual(r, { approvable: true, reason: null, status, warnings: [] });
  }
});

test("preview: inscrição inexistente ou de outro evento → NOT_FOUND", async () => {
  const { svc } = setup();
  assert.deepEqual(await svc.preview({ eventId: 2, signupId: 999 }), {
    approvable: false,
    reason: "NOT_FOUND",
    status: null,
    warnings: [],
  });
  assert.equal((await svc.preview({ eventId: 5, signupId: 3 })).reason, "NOT_FOUND");
  assert.equal((await svc.preview({ eventId: "abc", signupId: 3 })).reason, "NOT_FOUND");
});

test("preview: sem pagamento, confirmada, reembolsada e já aprovada não são aprováveis", async () => {
  const noPay = setup({ signups: [signup({ payment_id: null })], payments: [] });
  assert.deepEqual(await noPay.svc.preview({ eventId: 2, signupId: 3 }), {
    approvable: false,
    reason: "NO_PAYMENT",
    status: null,
    warnings: [],
  });
  const cases = [
    [payment({ status: "CONFIRMED" }), "ALREADY_CONFIRMED", "CONFIRMED"],
    [payment({ status: "REFUND" }), "REFUNDED", "REFUND"],
    [payment({ status: "CONFIRMED", manual_approved_at: NOW, manual_approved_by: ADMIN }), "ALREADY_APPROVED", "CONFIRMED"],
  ];
  for (const [p, reason, status] of cases) {
    const { svc } = setup({ payments: [p] });
    assert.deepEqual(await svc.preview({ eventId: 2, signupId: 3 }), { approvable: false, reason, status, warnings: [] });
  }
});

test("preview: avisa lote lotado, evento lotado e cupom esgotado, ignorando o próprio pagamento", async () => {
  const p = payment({
    status: "PEDING_PAYMENT",
    coupon_id: 9,
    batch: { id: 11, max_quantity: 2 },
    coupon: { id: 9, max_uses: 1 },
  });
  const { svc } = setup({
    signups: [signup({ event: { ...EVENT, max_slots: 2 } })],
    payments: [p, ...others(2, { coupon_id: 9 })],
  });
  const r = await svc.preview({ eventId: 2, signupId: 3 });
  assert.equal(r.approvable, true);
  assert.deepEqual(r.warnings, ["BATCH_FULL", "EVENT_FULL", "COUPON_EXHAUSTED"]);
});

test("preview: com vaga sobrando (contando só as ativas) não avisa", async () => {
  const p = payment({ batch: { id: 11, max_quantity: 2 }, coupon_id: 9, coupon: { id: 9, max_uses: 2 } });
  const { svc } = setup({
    signups: [signup({ event: { ...EVENT, max_slots: 2 } })],
    payments: [
      p,
      ...others(1, { coupon_id: 9 }),
      // Não ocupam vaga: vencido, cancelado e pendente sem prazo (Pix Aí antigo).
      { id: 201, status: "EXPIRED", event_id: 2, batch_id: 11, coupon_id: 9 },
      { id: 202, status: "CANCELED", event_id: 2, batch_id: 11, coupon_id: 9 },
      { id: 203, status: "PEDING_PAYMENT", expires_at: null, event_id: 2, batch_id: 11, coupon_id: 9 },
    ],
  });
  assert.deepEqual((await svc.preview({ eventId: 2, signupId: 3 })).warnings, []);
});

test("preview: pendente com prazo ocupa vaga", async () => {
  const { svc } = setup({
    payments: [
      payment({ batch: { id: 11, max_quantity: 1 } }),
      { id: 301, status: "PEDING_PAYMENT", expires_at: NOW, event_id: 2, batch_id: 11 },
    ],
  });
  assert.deepEqual((await svc.preview({ eventId: 2, signupId: 3 })).warnings, ["BATCH_FULL"]);
});

// ---------- aprovação ----------

test("approve: confirma sem cobrança, registra quem e quando e mantém o histórico", async () => {
  const { svc, db } = setup();
  const r = await svc.approve({ eventId: 2, signupId: 3, approvedBy: ADMIN });
  assert.equal(r.httpStatus, 200);
  assert.deepEqual(r.body, {
    approved: true,
    already_approved: false,
    warnings: [],
    payment: { id: 7, status: "CONFIRMED", value: 5000, manual_approved_at: NOW, manual_approved_by: ADMIN },
    signup: { id: 3, documentId: null, name: "Ana", email: "ana@x.com", phone_number: "11999", cpf: "12345678909" },
    event: { id: 2, uuid: "u-2", slug: "ev" },
  });
  const p = db.payments[0];
  assert.equal(p.status, "CONFIRMED");
  assert.equal(p.confirmed_at, NOW);
  assert.equal(p.manual_approved_at, NOW);
  assert.deepEqual(p.manual_approved_by, ADMIN);
  assert.equal(p.value, 5000);
  assert.equal(p.original_value, 5000);
  assert.equal(p.batch_id, 11);
});

test("approve: só transiciona a partir de pendente, vencido ou cancelado", async () => {
  const { svc, db } = setup({ payments: [payment({ status: "PEDING_PAYMENT" })] });
  await svc.approve({ eventId: 2, signupId: 3, approvedBy: ADMIN });
  assert.equal(db.payments[0].status, "CONFIRMED");
});

test("approve: só guarda id, email e name de quem aprovou", async () => {
  const { svc, db } = setup();
  await svc.approve({ eventId: 2, signupId: "3", approvedBy: { id: 42, email: "a@x.com", name: "A", role: "admin", token: "x" } });
  assert.deepEqual(db.payments[0].manual_approved_by, { id: "42", email: "a@x.com", name: "A" });
});

test("approve: já aprovada manualmente → 200 already_approved sem alterar nada", async () => {
  const before = new Date("2026-11-01T00:00:00Z");
  const old = { id: "1", email: "first@x.com", name: "Primeiro" };
  const { svc, db } = setup({
    payments: [payment({ status: "CONFIRMED", manual_approved_at: before, manual_approved_by: old, confirmed_at: before })],
  });
  const r = await svc.approve({ eventId: 2, signupId: 3, approvedBy: ADMIN });
  assert.equal(r.httpStatus, 200);
  assert.equal(r.body.approved, true);
  assert.equal(r.body.already_approved, true);
  assert.deepEqual(r.body.warnings, []);
  assert.equal(r.body.payment.manual_approved_at, before);
  assert.deepEqual(r.body.payment.manual_approved_by, old);
  assert.equal(db.approveCalls, 0);
  assert.equal(db.payments[0].confirmed_at, before);
});

test("approve: erros 404 e 409", async () => {
  const notFound = setup();
  assert.deepEqual(await notFound.svc.approve({ eventId: 2, signupId: 999, approvedBy: ADMIN }), {
    httpStatus: 404,
    body: { error: { code: "NOT_FOUND" } },
  });
  assert.equal((await notFound.svc.approve({ eventId: 5, signupId: 3, approvedBy: ADMIN })).httpStatus, 404);

  const noPay = setup({ signups: [signup({ payment_id: null })], payments: [] });
  assert.deepEqual(await noPay.svc.approve({ eventId: 2, signupId: 3, approvedBy: ADMIN }), {
    httpStatus: 409,
    body: { error: { code: "NO_PAYMENT" } },
  });
  for (const [status, code] of [
    ["CONFIRMED", "ALREADY_CONFIRMED"],
    ["REFUND", "REFUNDED"],
  ]) {
    const s = setup({ payments: [payment({ status })] });
    assert.deepEqual(await s.svc.approve({ eventId: 2, signupId: 3, approvedBy: ADMIN }), {
      httpStatus: 409,
      body: { error: { code } },
    });
    assert.equal(s.db.payments[0].status, status);
    assert.equal(s.db.payments[0].manual_approved_at, null);
  }
});

test("approve: sem approved_by → 400 e nada muda", async () => {
  for (const approvedBy of [undefined, null, {}, { name: "Só nome" }]) {
    const { svc, db } = setup();
    const r = await svc.approve({ eventId: 2, signupId: 3, approvedBy });
    assert.equal(r.httpStatus, 400);
    assert.equal(r.body.error.code, "INVALID_APPROVER");
    assert.equal(db.payments[0].status, "EXPIRED");
  }
});

test("approve: permitido com lote/evento lotado e cupom esgotado, devolvendo os avisos", async () => {
  const p = payment({ coupon_id: 9, batch: { id: 11, max_quantity: 1 }, coupon: { id: 9, max_uses: 1 } });
  const { svc, db } = setup({
    signups: [signup({ event: { ...EVENT, max_slots: 1 } })],
    payments: [p, ...others(1, { coupon_id: 9 })],
  });
  const r = await svc.approve({ eventId: 2, signupId: 3, approvedBy: ADMIN });
  assert.equal(r.httpStatus, 200);
  assert.deepEqual(r.body.warnings, ["BATCH_FULL", "EVENT_FULL", "COUPON_EXHAUSTED"]);
  assert.equal(db.payments[0].status, "CONFIRMED");
});

test("approve: webhook confirmou no meio (transição condicional falha) → 409 ALREADY_CONFIRMED", async () => {
  const { svc, db } = setup();
  const original = db.approve;
  db.approve = async (id, from, data) => {
    Object.assign(db.payments[0], { status: "CONFIRMED", confirmed_at: NOW }); // o webhook chegou antes
    return original(id, from, data);
  };
  const r = await svc.approve({ eventId: 2, signupId: 3, approvedBy: ADMIN });
  assert.deepEqual(r, { httpStatus: 409, body: { error: { code: "ALREADY_CONFIRMED" } } });
  assert.equal(db.payments[0].manual_approved_at, null);
});

test("approve: duas aprovações ao mesmo tempo → a segunda volta already_approved", async () => {
  const { svc, db } = setup();
  const original = db.approve;
  db.approve = async (id, from, data) => {
    Object.assign(db.payments[0], { status: "CONFIRMED", manual_approved_at: NOW, manual_approved_by: { id: "1", email: "o@x.com", name: "Outro" } });
    return original(id, from, data);
  };
  const r = await svc.approve({ eventId: 2, signupId: 3, approvedBy: ADMIN });
  assert.equal(r.httpStatus, 200);
  assert.equal(r.body.already_approved, true);
  assert.equal(r.body.payment.manual_approved_by.name, "Outro");
});
