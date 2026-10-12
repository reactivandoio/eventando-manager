// Teste de integração do REA-6 contra MySQL de verdade e o Opa Pingou simulado (servidor local).
// Não roda no `yarn test` (precisa de banco). Uso:
//
//   docker run -d --name rea6-mysql -e MYSQL_DATABASE=rea6 -e MYSQL_USER=strapi \
//     -e MYSQL_PASSWORD=strapi -e MYSQL_ROOT_PASSWORD=root -p 3307:3306 mysql:8
//   DATABASE_PORT=3307 node test/concurrency/signup-race.js
//
// Cobre: 10 inscrições simultâneas na última vaga do evento → 1 aceita; 10 no último uso do
// cupom → 1 com cupom; mesma pessoa duas vezes ao mesmo tempo → 1 inscrição; repetir com Pix
// válido devolve a mesma cobrança; Pix vencido → nova tentativa com nova chave; cupom que zera
// confirma na hora; webhook paid → CONFIRMED e expired atrasado não desfaz; CPF fora da resposta.

const http = require("node:http");
const assert = require("node:assert/strict");

process.env.NODE_ENV = process.env.NODE_ENV || "development";
Object.assign(process.env, {
  DATABASE_CLIENT: "mysql2",
  DATABASE_HOST: process.env.DATABASE_HOST || "127.0.0.1",
  DATABASE_PORT: process.env.DATABASE_PORT || "3307",
  DATABASE_NAME: process.env.DATABASE_NAME || "rea6",
  DATABASE_USERNAME: process.env.DATABASE_USERNAME || "strapi",
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD || "strapi",
  DATABASE_POOL_MAX: "20",
  APP_KEYS: "k1,k2",
  API_TOKEN_SALT: "salt",
  ADMIN_JWT_SECRET: "adm",
  TRANSFER_TOKEN_SALT: "tr",
  JWT_SECRET: "jwt",
  OPAPINGOU_ENABLED: "true",
  OPAPINGOU_API_KEY: "opk_test_integration_fake",
});

// ---------- Opa Pingou simulado ----------
const charges = new Map(); // id → charge
const byKey = new Map(); // Idempotency-Key → id
const seen = { creates: 0, keys: [] };
let nextId = 1;
const runTag = Date.now().toString(36);
const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== "Bearer opk_test_integration_fake") return send(401, { code: "UNAUTHENTICATED" });
    if (req.method === "POST" && req.url === "/v1/charges") {
      const key = req.headers["idempotency-key"];
      seen.keys.push(key);
      if (byKey.has(key)) return send(201, charges.get(byKey.get(key)), { "idempotent-replayed": "true" });
      const body = JSON.parse(raw);
      if (body.kind === "PAYMENT_LINK" && body.amountCents === 777) return send(422, { code: "PAYMENT_LINK_UNAVAILABLE", requestId: "r1" });
      seen.creates += 1;
      const id = `ch_${runTag}_${nextId++}`;
      const charge = {
        id,
        txid: `tx${id}`,
        status: "PENDING",
        amountCents: body.amountCents,
        brCode: body.kind === "PIX_QR" ? `000201${id}` : null,
        paymentLink: body.kind === "PAYMENT_LINK" ? `https://mp.test/${id}` : null,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
      charges.set(id, charge);
      byKey.set(key, id);
      return send(201, charge);
    }
    const m = req.url.match(/^\/v1\/charges\/(.+)$/);
    if (req.method === "GET" && m) return charges.has(m[1]) ? send(200, charges.get(m[1])) : send(404, { code: "NOT_FOUND" });
    return send(404, { code: "NOT_FOUND" });
  });
});

// CPF válido a partir de 9 dígitos.
const cpfFrom = (n) => {
  const d = String(100000000 + n).slice(-9).split("").map(Number);
  const dig = (len) => {
    let s = 0;
    for (let i = 0; i < len; i += 1) s += d[i] * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  d.push(dig(9));
  d.push(dig(10));
  return d.join("");
};

const call = async (strapi, eventId, body) => {
  const out = {};
  const ctx = {
    params: { id: String(eventId) },
    request: { body },
    send(payload, status) {
      out.status = status;
      out.body = payload;
    },
  };
  await strapi.controller("api::signup.signup").customCreate(ctx);
  return out;
};

const processEvent = async (strapi, body) => {
  const out = {};
  const mk = (extra) => ({ params: {}, query: {}, request: { body: {} }, ...extra, send(p, s) { out.status = s; out.body = p; } });
  const ctrl = strapi.controller("api::opapingou-event.opapingou-event");
  await ctrl.store(mk({ request: { body } }));
  await ctrl.process(mk({ params: { eventId: body.event_id } }));
  return out;
};

(async () => {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  process.env.OPAPINGOU_API_URL = `http://127.0.0.1:${mock.address().port}`;

  const strapi = await require("@strapi/strapi")({ appDir: process.cwd(), distDir: process.cwd() }).load();
  const q = (uid) => strapi.db.query(uid);
  let failures = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`ok   - ${name}`);
    } catch (err) {
      failures += 1;
      console.log(`FAIL - ${name}\n       ${err.message.split("\n").join("\n       ")}`);
    }
  };

  const tag = Date.now().toString(36);
  const mkEvent = async ({ max_slots = null, value = 1000, batchMax = null, half = false } = {}) => {
    const event = await q("api::event.event").create({ data: { name: `REA6 ${tag}`, max_slots, payment_provider: "opapingou" } });
    const product = await q("api::product.product").create({ data: { name: "Ingresso", enabled: true, event: event.id } });
    const batch = await q("api::batch.batch").create({
      data: { batch_number: 1, value, enabled: true, max_quantity: batchMax, half_price_eligible: half, product: product.id },
    });
    return { event, batch };
  };
  const person = (i, extra = {}) => ({ name: `P${i}`, email: `p${i}-${tag}@x.test`, cpf: cpfFrom(i), ...extra });
  let seq = 1;

  await check("10 simultâneas na última vaga do evento → exatamente 1 aceita", async () => {
    const { event, batch } = await mkEvent({ max_slots: 1 });
    const base = (seq += 20);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call(strapi, event.id, { ...person(base + i), batch_id: batch.id }))
    );
    const ok = results.filter((r) => r.status === 200);
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => [r.status, r.body.message])));
    assert.ok(results.filter((r) => r.status !== 200).every((r) => /lotação/.test(r.body.message)));
    assert.equal(await q("api::signup.signup").count({ where: { event: event.id } }), 1);
  });

  await check("10 simultâneas no último uso do lote → exatamente 1 aceita", async () => {
    const { event, batch } = await mkEvent({ batchMax: 1 });
    const base = (seq += 20);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call(strapi, event.id, { ...person(base + i), batch_id: batch.id }))
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1);
  });

  await check("10 simultâneas no último uso do cupom → exatamente 1 com cupom", async () => {
    const { event, batch } = await mkEvent();
    await q("api::coupon.coupon").create({ data: { code: `RACE${tag}`, discount_type: "percentage", discount_percentage: 10, max_uses: 1, enabled: true, event: event.id } });
    const base = (seq += 20);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call(strapi, event.id, { ...person(base + i), batch_id: batch.id, coupon_code: `race${tag}` }))
    );
    const ok = results.filter((r) => r.status === 200);
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => [r.status, r.body.message])));
    assert.equal(ok[0].body.value, 900);
    assert.equal(ok[0].body.discount_kind, "coupon");
    assert.ok(results.filter((r) => r.status !== 200).every((r) => /limite de usos/.test(r.body.message)));
  });

  await check("mesma pessoa duas vezes ao mesmo tempo → 1 inscrição e 1 cobrança", async () => {
    const { event, batch } = await mkEvent();
    const p = person((seq += 20));
    const creates = seen.creates;
    const [a, b] = await Promise.all([call(strapi, event.id, { ...p, batch_id: batch.id }), call(strapi, event.id, { ...p, batch_id: batch.id })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.payment_id, b.body.payment_id);
    assert.equal(a.body.pix_br_code, b.body.pix_br_code);
    assert.equal(await q("api::signup.signup").count({ where: { event: event.id } }), 1);
    assert.equal(seen.creates - creates, 1);
  });

  await check("resposta sem CPF, com Pix, prazo e chave signup-payment-<id>-v1", async () => {
    const { event, batch } = await mkEvent();
    const p = person((seq += 20));
    const r = await call(strapi, event.id, { ...p, batch_id: batch.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.cpf, undefined);
    assert.ok(!JSON.stringify(r.body).includes(p.cpf));
    assert.equal(r.body.payment_provider, "opapingou");
    assert.equal(r.body.kind, "PIX_QR");
    assert.ok(r.body.pix_br_code);
    assert.ok(r.body.expires_at);
    assert.equal(r.body.value, 1000);
    assert.equal(r.body.is_free, false);
    assert.equal(seen.keys[seen.keys.length - 1], `signup-payment-${r.body.payment_id}-v1`);
    const signup = await q("api::signup.signup").findOne({ where: { id: r.body.signup_id } });
    assert.equal(signup.cpf, p.cpf);
  });

  await check("Pix vencido → nova tentativa (v2) na mesma inscrição; vaga volta", async () => {
    const { event, batch } = await mkEvent({ max_slots: 1 });
    const p = person((seq += 20));
    const first = await call(strapi, event.id, { ...p, batch_id: batch.id });
    await q("api::payment.payment").update({ where: { id: first.body.payment_id }, data: { expires_at: new Date(Date.now() - 1000) } });
    const other = await call(strapi, event.id, { ...person(seq + 1), batch_id: batch.id });
    assert.equal(other.status, 200, "a vaga do Pix vencido deveria ter voltado");
    const again = await call(strapi, event.id, { ...p, batch_id: batch.id });
    assert.equal(again.status, 400, "sem vaga: a outra pessoa ficou com ela");
    assert.match(again.body.message, /lotação/);

    const { event: e2, batch: b2 } = await mkEvent();
    const p2 = person((seq += 20));
    const one = await call(strapi, e2.id, { ...p2, batch_id: b2.id });
    await q("api::payment.payment").update({ where: { id: one.body.payment_id }, data: { expires_at: new Date(Date.now() - 1000) } });
    const two = await call(strapi, e2.id, { ...p2, batch_id: b2.id });
    assert.equal(two.status, 200);
    assert.equal(two.body.payment_id, one.body.payment_id);
    assert.notEqual(two.body.pix_br_code, one.body.pix_br_code);
    assert.equal(seen.keys[seen.keys.length - 1], `signup-payment-${one.body.payment_id}-v2`);
    const pay = await q("api::payment.payment").findOne({ where: { id: one.body.payment_id } });
    assert.equal(pay.attempt, 2);
    assert.ok(String(pay.previous_charge_ids).includes(one.body.pix_br_code.replace("000201", "")));
    assert.equal(pay.payment_identification, `opapingou_${pay.provider_charge_id}`);
  });

  await check("trocar Pix por link é nova tentativa; link indisponível vira 400 e libera", async () => {
    const { event, batch } = await mkEvent();
    const p = person((seq += 20));
    const pix = await call(strapi, event.id, { ...p, batch_id: batch.id });
    const link = await call(strapi, event.id, { ...p, batch_id: batch.id, kind: "PAYMENT_LINK" });
    assert.equal(link.status, 200);
    assert.equal(link.body.kind, "PAYMENT_LINK");
    assert.ok(link.body.payment_link);
    assert.equal(link.body.payment_id, pix.body.payment_id);

    const { event: e2, batch: b2 } = await mkEvent({ value: 777 });
    const r = await call(strapi, e2.id, { ...person((seq += 20)), batch_id: b2.id, kind: "PAYMENT_LINK" });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Link indisponível/);
    const pay = await q("api::payment.payment").findOne({ where: { event: e2.id } });
    assert.equal(pay.status, "CANCELED");
  });

  await check("cupom que zera confirma na hora, conta uso e não cria cobrança", async () => {
    const { event, batch } = await mkEvent();
    await q("api::coupon.coupon").create({ data: { code: `FREE${tag}`, discount_type: "percentage", discount_percentage: 100, max_uses: 5, enabled: true, event: event.id } });
    const creates = seen.creates;
    const r = await call(strapi, event.id, { ...person((seq += 20)), batch_id: batch.id, coupon_code: `FREE${tag}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.is_free, true);
    assert.equal(r.body.status, "CONFIRMED");
    assert.equal(seen.creates, creates);
    const pay = await q("api::payment.payment").findOne({ where: { id: r.body.payment_id }, populate: { coupon: true } });
    assert.ok(pay.coupon);
  });

  await check("um cupom por CPF no evento; empate com meia não consome o cupom", async () => {
    const { event, batch } = await mkEvent({ half: true });
    await q("api::coupon.coupon").create({ data: { code: `A${tag}`, discount_percentage: 10, enabled: true, event: event.id } });
    await q("api::coupon.coupon").create({ data: { code: `B${tag}`, discount_percentage: 50, enabled: true, event: event.id } });
    const cpf = cpfFrom((seq += 20));
    const first = await call(strapi, event.id, { name: "X", email: `x1-${tag}@x.test`, cpf, batch_id: batch.id, coupon_code: `A${tag}` });
    assert.equal(first.status, 200);
    // REA-22: com a primeira inscrição segurando a vaga, o mesmo CPF já nem ganha outra.
    const second = await call(strapi, event.id, { name: "X", email: `x2-${tag}@x.test`, cpf, batch_id: batch.id, coupon_code: `A${tag}` });
    assert.equal(second.status, 400);
    assert.equal(second.body.code, "ALREADY_SIGNED_UP");
    // Com o Pix da primeira vencido, a vaga e o cupom voltam e o CPF se inscreve com outro cupom.
    await q("api::payment.payment").update({ where: { id: first.body.payment_id }, data: { expires_at: new Date(Date.now() - 1000) } });
    const third = await call(strapi, event.id, { name: "X", email: `x3-${tag}@x.test`, cpf, batch_id: batch.id, coupon_code: `B${tag}` });
    assert.equal(third.status, 200, JSON.stringify(third.body));
    const tie = await call(strapi, event.id, { ...person(seq + 3), batch_id: batch.id, coupon_code: `B${tag}`, is_student: true });
    assert.equal(tie.status, 200);
    assert.equal(tie.body.discount_kind, "student");
    assert.equal(tie.body.value, 500);
    const pay = await q("api::payment.payment").findOne({ where: { id: tie.body.payment_id }, populate: { coupon: true } });
    assert.equal(pay.coupon, null);
  });

  await check("REA-22: mesmo CPF com outro e-mail → ALREADY_SIGNED_UP e 1 inscrição (também ao mesmo tempo)", async () => {
    const { event, batch } = await mkEvent({ value: 0 });
    const cpf = cpfFrom((seq += 20));
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => call(strapi, event.id, { name: "Z", email: `z${i}-${tag}@x.test`, cpf, batch_id: batch.id }))
    );
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => [r.status, r.body.code])));
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.code === "ALREADY_SIGNED_UP"));
    assert.equal(await q("api::signup.signup").count({ where: { event: event.id } }), 1);
    const sameEmail = await call(strapi, event.id, { name: "Z", email: results.find((r) => r.status === 200).body.email, cpf, batch_id: batch.id });
    assert.equal(sameEmail.body.code, "ALREADY_SIGNED_UP");
  });

  await check("REA-22: signup-holder acha pelo CPF ou e-mail, traz o e-mail e nunca o CPF; vencido não conta", async () => {
    const holderCall = async (eventId, body) => {
      const out = {};
      await strapi.controller("api::signup.signup").holder({
        params: { id: String(eventId) },
        request: { body },
        send(payload, status) { out.status = status; out.body = payload; },
      });
      return out;
    };
    const { event, batch } = await mkEvent();
    const p = person((seq += 20));
    const r = await call(strapi, event.id, { ...p, batch_id: batch.id });
    const byCpf = await holderCall(event.id, { cpf: p.cpf });
    assert.equal(byCpf.status, 200);
    assert.equal(byCpf.body.holder.email, p.email);
    assert.equal(byCpf.body.holder.payment_status, "PEDING_PAYMENT");
    assert.equal(byCpf.body.holder.value, 1000);
    assert.ok(!JSON.stringify(byCpf.body).includes(p.cpf));
    const byEmail = await holderCall(event.id, { emails: [p.email.toUpperCase()] });
    assert.equal(byEmail.body.holder.signup_id, r.body.signup_id);
    await q("api::payment.payment").update({ where: { id: r.body.payment_id }, data: { expires_at: new Date(Date.now() - 1000) } });
    assert.equal((await holderCall(event.id, { cpf: p.cpf })).body.holder, null);
    assert.equal((await holderCall(event.id, {})).body.holder, null);
  });

  await check("CPF inválido ou ausente com cupom → 400 com 'CPF' e sem ecoar o valor", async () => {
    const { event, batch } = await mkEvent();
    const bad = await call(strapi, event.id, { name: "Y", email: `y-${tag}@x.test`, cpf: "529.982.247-24", batch_id: batch.id });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /CPF/);
    assert.ok(!JSON.stringify(bad.body).includes("529"));
    await q("api::coupon.coupon").create({ data: { code: `C${tag}`, discount_percentage: 10, enabled: true, event: event.id } });
    const none = await call(strapi, event.id, { name: "Y", email: `y2-${tag}@x.test`, batch_id: batch.id, coupon_code: `C${tag}` });
    assert.equal(none.status, 400);
    assert.match(none.body.message, /CPF/);
  });

  await check("webhook: paid → CONFIRMED uma vez; expired atrasado não desfaz", async () => {
    const { event, batch } = await mkEvent();
    const r = await call(strapi, event.id, { ...person((seq += 20)), batch_id: batch.id });
    const pay = await q("api::payment.payment").findOne({ where: { id: r.body.payment_id } });
    charges.get(pay.provider_charge_id).status = "PAID";
    const a = await processEvent(strapi, { event_id: `evt_a_${tag}`, type: "charge.paid", charge_id: pay.provider_charge_id, payload: {} });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.transitioned, true);
    assert.equal(a.body.status, "CONFIRMED");
    assert.equal(a.body.payment.signup.email, person(seq).email);
    const again = await processEvent(strapi, { event_id: `evt_a_${tag}`, type: "charge.paid", charge_id: pay.provider_charge_id });
    assert.equal(again.body.transitioned, false);
    charges.get(pay.provider_charge_id).status = "EXPIRED";
    const late = await processEvent(strapi, { event_id: `evt_b_${tag}`, type: "charge.expired", charge_id: pay.provider_charge_id });
    assert.equal(late.body.transitioned, false);
    assert.equal((await q("api::payment.payment").findOne({ where: { id: pay.id } })).status, "CONFIRMED");
  });

  await check("cupom: código repetido no mesmo evento recusado; tipo/valor travam com uso", async () => {
    const { event, batch } = await mkEvent();
    const svc = strapi.entityService;
    const c = await svc.create("api::coupon.coupon", { data: { code: `U${tag}`, discount_percentage: 10, enabled: true, event: event.id } });
    await assert.rejects(svc.create("api::coupon.coupon", { data: { code: `u${tag}`, discount_percentage: 5, event: event.id } }), /Já existe/);
    const { event: other } = await mkEvent();
    await svc.create("api::coupon.coupon", { data: { code: `U${tag}`, discount_percentage: 5, event: other.id } });
    await call(strapi, event.id, { ...person((seq += 20)), batch_id: batch.id, coupon_code: `U${tag}` });
    await assert.rejects(svc.update("api::coupon.coupon", c.id, { data: { discount_percentage: 50 } }), /já foi usado/);
    await svc.update("api::coupon.coupon", c.id, { data: { max_uses: 10 } });
  });

  await check("POST /api/signups (inscrição na porta do BFF) grava o cpf private e não o devolve", async () => {
    const { event } = await mkEvent();
    const cpf = cpfFrom((seq += 20));
    const ctx = {
      params: {},
      query: {},
      state: {},
      request: { body: { data: { name: "Porta", email: `porta-${tag}@x.test`, cpf, event: event.id } }, query: {} },
      is: () => false,
    };
    const body = await strapi.controller("api::signup.signup").create(ctx);
    const out = body || ctx.body;
    assert.ok(out && out.data && out.data.id, JSON.stringify(out));
    assert.equal(out.data.attributes.cpf, undefined);
    const row = await q("api::signup.signup").findOne({ where: { id: out.data.id } });
    assert.equal(row.cpf, cpf);
  });

  await check("REA-15: evento ainda marcado pixai cobra pelo Opa Pingou", async () => {
    const { event, batch } = await mkEvent();
    await q("api::event.event").update({ where: { id: event.id }, data: { payment_provider: "pixai" } });
    const r = await call(strapi, event.id, { ...person((seq += 20)), batch_id: batch.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.payment_provider, "opapingou");
    assert.ok(r.body.pix_br_code);
    assert.equal(r.body.qr_code, undefined);
  });

  await check("REA-15: pendente antigo do Pix Aí vira nova tentativa pelo Opa Pingou", async () => {
    const { event, batch } = await mkEvent({ max_slots: 1 });
    const p = person((seq += 20));
    const legacy = await q("api::payment.payment").create({
      data: { value: 1000, original_value: 1000, status: "PEDING_PAYMENT", event: event.id, batch: batch.id, pix_qr_code: "legado", payment_identification: `legacy_${tag}` },
    });
    await q("api::signup.signup").create({ data: { name: p.name, email: p.email, event: event.id, payment: legacy.id } });
    const r = await call(strapi, event.id, { ...p, batch_id: batch.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.payment_id, legacy.id);
    assert.equal(r.body.payment_provider, "opapingou");
    const pay = await q("api::payment.payment").findOne({ where: { id: legacy.id } });
    assert.equal(pay.provider, "opapingou");
    assert.equal(pay.attempt, 2);
    assert.equal(pay.pix_qr_code, null);
  });

  await check("REA-15: pendente antigo do Pix Aí não ocupa vaga nem conta uso de cupom", async () => {
    const { event, batch } = await mkEvent({ max_slots: 1 });
    const coupon = await q("api::coupon.coupon").create({ data: { code: `L${tag}`, discount_percentage: 10, max_uses: 1, enabled: true, event: event.id } });
    await q("api::payment.payment").create({
      data: { value: 900, status: "PEDING_PAYMENT", event: event.id, batch: batch.id, coupon: coupon.id, payment_identification: `legacy_slot_${tag}` },
    });
    const r = await call(strapi, event.id, { ...person((seq += 20)), batch_id: batch.id, coupon_code: `L${tag}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.discount_kind, "coupon");
  });

  await check("REA-15: confirmado antigo do Pix Aí continua inscrito", async () => {
    const { event, batch } = await mkEvent();
    const p = person((seq += 20));
    const old = await q("api::payment.payment").create({
      data: { value: 1000, status: "CONFIRMED", event: event.id, batch: batch.id, pix_qr_code: "legado", payment_identification: `legacy_ok_${tag}` },
    });
    await q("api::signup.signup").create({ data: { name: p.name, email: p.email, event: event.id, payment: old.id } });
    const r = await call(strapi, event.id, { ...p, batch_id: batch.id });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /já está inscrito/);
    assert.equal((await q("api::payment.payment").findOne({ where: { id: old.id } })).status, "CONFIRMED");
  });

  await check("REA-15: OPAPINGOU_ENABLED desligada recusa a paga (503) e aceita a gratuita", async () => {
    const { event, batch } = await mkEvent();
    const { event: freeEvent, batch: freeBatch } = await mkEvent({ value: 0 });
    process.env.OPAPINGOU_ENABLED = "false";
    try {
      const paid = await call(strapi, event.id, { ...person((seq += 20)), batch_id: batch.id });
      assert.equal(paid.status, 503);
      assert.equal(await q("api::payment.payment").count({ where: { event: event.id } }), 0);
      const free = await call(strapi, freeEvent.id, { ...person(seq + 1), batch_id: freeBatch.id });
      assert.equal(free.status, 200);
      assert.equal(free.body.is_free, true);
    } finally {
      process.env.OPAPINGOU_ENABLED = "true";
    }
  });

  await strapi.destroy();
  mock.close();
  console.log(failures ? `\n${failures} falha(s).` : "\nTudo certo.");
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
