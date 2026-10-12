"use strict";

// Conexões com contas do Opa Pingou (REA-12). Cada evento pago cobra pela conta Opa Pingou da
// própria comunidade: a pessoa cola a chave opk_ no admin, o Eventando valida, cadastra nessa conta
// um endpoint de webhook apontando para o BFF (…/webhooks/opapingou/<id público da conexão>) e guarda
// a chave e o whsec_ cifrados (utils/secret-box). Uma conexão por empresa e modo: o Opa Pingou aceita
// só 10 endpoints ativos por empresa, então outro evento da mesma empresa reaproveita a conexão.
//
// Nada daqui devolve ou registra a chave, o whsec_ ou os dados pessoais do /v1/me: o resumo traz só
// a razão social, o CNPJ mascarado, o modo e os 4 últimos caracteres da chave.

const crypto = require("node:crypto");
const { OpaPingouError } = require("../../../datasources/opapingou/errors");
const { verifyOpaSignature } = require("../../../utils/opa-signature");

const DEFAULT_WEBHOOK_BASE_URL = "https://bff.hubcommunity.io/webhooks/opapingou";
const WEBHOOK_EVENTS = [
  "charge.paid",
  "charge.expired",
  "charge.canceled",
  "payment.confirmed",
  "payment.refunded",
  "payment.charged_back",
];
const KEY_PATTERN = /^opk_(live|test)_[A-Za-z0-9_-]{20,200}$/;

const ERRORS = {
  INVALID_KEY_FORMAT: [400, "Cole a chave inteira do Opa Pingou: ela começa com opk_live_."],
  TEST_KEY_NOT_ALLOWED: [400, "Chaves de teste (opk_test_) não são aceitas aqui. Use a chave de produção (opk_live_)."],
  EVENT_NOT_FOUND: [404, "Evento não encontrado."],
  INVALID_KEY: [400, "O Opa Pingou não reconheceu esta chave. Confira se ela foi copiada inteira e se ainda está ativa."],
  MISSING_SCOPES: [400, "A chave não tem todas as permissões necessárias. Crie uma chave nova com as permissões indicadas."],
  NO_COMPANY: [400, "A conta desta chave ainda não tem uma empresa cadastrada no Opa Pingou. Termine o cadastro e tente de novo."],
  ENDPOINT_LIMIT: [409, "Esta conta do Opa Pingou já tem 10 webhooks ativos. Desative um que não use mais no painel do Opa Pingou e tente de novo."],
  OPAPINGOU_UNAVAILABLE: [503, "Não conseguimos falar com o Opa Pingou agora. Tente de novo em instantes."],
  CONNECTION_NOT_FOUND: [404, "Conta Opa Pingou não encontrada."],
  PENDING_PAYMENTS: [409, "Este evento tem pagamentos em aberto. Tente de novo depois que eles forem pagos ou vencerem (até 15 minutos)."],
  NOT_CONFIGURED: [503, "A conexão com o Opa Pingou ainda não está disponível. Fale com o suporte do Hub."],
  SETUP_FAILED: [500, "Não foi possível concluir a conexão com o Opa Pingou. Tente de novo; se continuar, fale com o suporte do Hub."],
};

class ConnectionError extends Error {
  constructor(code, extra = {}) {
    const [status, userMessage] = ERRORS[code] || [500, "Erro inesperado."];
    super(`Conexão Opa Pingou: ${code}`);
    this.name = "ConnectionError";
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
    this.extra = extra;
  }
}

const maskCnpj = (cnpj) => {
  const digits = String(cnpj || "").replace(/\D/g, "");
  if (digits.length !== 14) return null;
  return `**.***.***/${digits.slice(8, 12)}-${digits.slice(12)}`;
};

const toSummary = (row) =>
  row && {
    id: row.public_id,
    company_name: row.company_name || null,
    company_document: row.company_document || null,
    test_mode: !!row.test_mode,
    key_last4: row.key_last4 || null,
    status: row.status,
    created_by: row.created_by || null,
    created_by_name: row.created_by_name || null,
    created_at: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };

const isTrue = (v) => String(v || "").toLowerCase() === "true";
const keyContext = (publicId) => `${publicId}:api_key`;
const secretContext = (publicId) => `${publicId}:webhook_secret`;

// Erro do Opa Pingou → erro da conexão. `stage` diz o que estava sendo feito.
const fromOpa = (err, stage) => {
  if (err instanceof ConnectionError) return err;
  if (!(err instanceof OpaPingouError)) return new ConnectionError("SETUP_FAILED");
  if (err.status === 401 || err.code === "API_KEY_INVALID") return new ConnectionError("INVALID_KEY");
  if (err.code === "INSUFFICIENT_SCOPE") {
    const missing = stage === "me" ? ["profile:read"] : stage === "endpoint" ? ["webhooks:write"] : [];
    return new ConnectionError("MISSING_SCOPES", { missing });
  }
  if (err.code === "WEBHOOK_ENDPOINT_LIMIT") return new ConnectionError("ENDPOINT_LIMIT");
  if (err.retryable || err.status === null || err.status === 429 || err.status >= 500) {
    return new ConnectionError("OPAPINGOU_UNAVAILABLE");
  }
  return new ConnectionError("SETUP_FAILED");
};

// Conta que cobra neste evento: { connectionId } (null = chave global OPAPINGOU_API_KEY, só para
// evento marcado como legado) ou null quando o evento não tem conta e não pode cobrar.
const chargeConnectionFor = (event, env = process.env) => {
  const conn = event && event.opapingou_connection;
  if (conn && conn.status === "active") return { connectionId: conn.id };
  if (conn) return null;
  if (event && event.opapingou_legacy && env.OPAPINGOU_API_KEY) return { connectionId: null };
  return null;
};

const createConnections = ({
  db,
  makeClient,
  box,
  env = process.env,
  now = () => new Date(),
  newPublicId = () => `opc_${crypto.randomBytes(18).toString("base64url")}`,
  log = { info() {}, warn() {}, error() {} },
}) => {
  const webhookBase = () => String(env.OPAPINGOU_WEBHOOK_BASE_URL || DEFAULT_WEBHOOK_BASE_URL).replace(/\/+$/, "");

  const clientFor = (connection) => {
    if (!connection) return makeClient(undefined); // chave global (OPAPINGOU_API_KEY)
    return makeClient(box.open(connection.key_encrypted, keyContext(connection.public_id)));
  };

  const loadEvent = async (eventUuid) => {
    const event = eventUuid ? await db.findEventByUuid(String(eventUuid)) : null;
    if (!event) throw new ConnectionError("EVENT_NOT_FOUND");
    return event;
  };

  // Mesma empresa e modo já conectados: o endpoint ainda existe e esta chave o enxerga?
  const reusable = async (client, existing) => {
    if (!existing || !existing.webhook_endpoint_id || !existing.webhook_secret_encrypted) return false;
    try {
      const ep = await client.getWebhookEndpoint(existing.webhook_endpoint_id);
      return !!ep && ep.status === "ACTIVE";
    } catch (err) {
      if (err instanceof OpaPingouError && (err.status === 404 || err.status === 403)) return false;
      throw fromOpa(err, "reuse");
    }
  };

  const createNew = async ({ client, apiKey, companyInfo, testMode, createdBy, createdByName }) => {
    const publicId = newPublicId();
    // A linha nasce provisória, sem segredo: se o cadastro do endpoint falhar, ela é apagada.
    const row = await db.createConnection({
      public_id: publicId,
      status: "pending",
      test_mode: testMode,
      ...companyInfo,
      key_last4: apiKey.slice(-4),
      key_encrypted: box.seal(apiKey, keyContext(publicId)),
      created_by: createdBy || null,
      created_by_name: createdByName || null,
    });

    let endpoint;
    try {
      endpoint = await client.createWebhookEndpoint({
        url: `${webhookBase()}/${publicId}`,
        description: "Hub Community - inscrições pagas",
        events: WEBHOOK_EVENTS,
      });
    } catch (err) {
      await db.deleteConnection(row.id);
      throw fromOpa(err, "endpoint");
    }

    const secret = endpoint && typeof endpoint.secret === "string" ? endpoint.secret : "";
    if (!endpoint || !endpoint.id || !secret.startsWith("whsec_")) {
      log.error(`[opapingou] endpoint ${endpoint && endpoint.id} da conexão ${publicId} veio sem segredo`);
      await db.deleteConnection(row.id);
      throw new ConnectionError("SETUP_FAILED");
    }

    try {
      return await db.updateConnection(row.id, {
        status: "active",
        webhook_endpoint_id: String(endpoint.id),
        webhook_secret_encrypted: box.seal(secret, secretContext(publicId)),
      });
    } catch (err) {
      // O endpoint existe no Opa Pingou mas o segredo não foi gravado: sem ele os webhooks dessa URL
      // são recusados. Fica o id para desativar no painel do Opa Pingou.
      log.error(`[ALERTA][opapingou] endpoint ${endpoint.id} cadastrado, mas a conexão ${publicId} não foi gravada`);
      throw new ConnectionError("SETUP_FAILED");
    }
  };

  return {
    clientFor,

    chargeConnectionFor: (event) => chargeConnectionFor(event, env),

    async forEvent(eventUuid) {
      const event = await loadEvent(eventUuid);
      return {
        connection: toSummary(event.opapingou_connection) || null,
        legacy: !event.opapingou_connection && !!event.opapingou_legacy,
      };
    },

    async list() {
      const rows = await db.listConnections();
      return rows
        .filter((r) => r.status === "active")
        .map((r) => ({ ...toSummary(r), event_uuids: (r.events || []).map((e) => e.uuid).filter(Boolean) }));
    },

    async connect({ eventUuid, apiKey, createdBy, createdByName }) {
      const key = typeof apiKey === "string" ? apiKey.trim() : "";
      const match = KEY_PATTERN.exec(key);
      if (!match) throw new ConnectionError("INVALID_KEY_FORMAT");
      const testMode = match[1] === "test";
      if (testMode && !isTrue(env.OPAPINGOU_ACCEPT_TEST_MODE)) throw new ConnectionError("TEST_KEY_NOT_ALLOWED");
      // Sem a chave mestra (OPAPINGOU_CREDENTIALS_KEY), para antes de cadastrar qualquer coisa no Opa Pingou.
      try {
        box.seal("", "ready");
      } catch (err) {
        log.error(`[ALERTA][opapingou] cofre de credenciais indisponível: ${err && err.code}`);
        throw new ConnectionError("NOT_CONFIGURED");
      }
      const event = await loadEvent(eventUuid);

      const client = makeClient(key);
      let profile;
      try {
        profile = await client.me();
      } catch (err) {
        throw fromOpa(err, "me");
      }
      const company = profile && profile.company;
      if (!company || !company.id) throw new ConnectionError("NO_COMPANY");

      let missing;
      try {
        missing = await client.missingScopes();
      } catch (err) {
        throw fromOpa(err, "scopes");
      }
      if (missing.length) throw new ConnectionError("MISSING_SCOPES", { missing });

      // Só o que identifica a empresa; CPF, telefone e e-mail do dono da chave são descartados.
      const companyInfo = {
        company_id: String(company.id),
        company_name: company.legalName ? String(company.legalName).slice(0, 255) : null,
        company_document: maskCnpj(company.cnpj),
      };

      let connection;
      const existing = await db.findActiveConnectionByCompany(companyInfo.company_id, testMode);
      if (await reusable(client, existing)) {
        connection = await db.updateConnection(existing.id, {
          ...companyInfo,
          key_last4: key.slice(-4),
          key_encrypted: box.seal(key, keyContext(existing.public_id)),
        });
        log.info(`[opapingou] conexão ${existing.public_id} reaproveitada para o evento ${event.uuid}`);
      } else {
        connection = await createNew({ client, apiKey: key, companyInfo, testMode, createdBy, createdByName });
        log.info(`[opapingou] conexão ${connection.public_id} criada para o evento ${event.uuid}`);
      }

      await db.setEventConnection(event.id, connection.id);
      return toSummary(connection);
    },

    async attach({ eventUuid, publicId }) {
      const event = await loadEvent(eventUuid);
      const connection = publicId ? await db.findConnectionByPublicId(String(publicId)) : null;
      if (!connection || connection.status !== "active") throw new ConnectionError("CONNECTION_NOT_FOUND");
      await db.setEventConnection(event.id, connection.id);
      return toSummary(connection);
    },

    // Solta o evento da conta (e do legado). Com pagamento em aberto, espera: a pessoa pode estar
    // pagando agora e a tela ficaria dizendo que o evento não tem conta.
    async detach({ eventUuid }) {
      const event = await loadEvent(eventUuid);
      const open = await db.countOpenPayments(event.id, now());
      if (open > 0) throw new ConnectionError("PENDING_PAYMENTS", { count: open });
      await db.setEventConnection(event.id, null, { opapingou_legacy: false });
      return { connection: null, legacy: false };
    },

    async verifyWebhook({ publicId, rawBody, signature, nowS }) {
      const connection = publicId ? await db.findConnectionByPublicId(String(publicId)) : null;
      if (!connection || !connection.webhook_secret_encrypted) return { found: false, valid: false };
      const secret = box.open(connection.webhook_secret_encrypted, secretContext(connection.public_id));
      const check = verifyOpaSignature({ rawBody, header: signature, secret, nowS });
      if (!check.ok) return { found: true, valid: false, reason: check.reason };
      return { found: true, valid: true, test_mode: !!connection.test_mode };
    },
  };
};

// Adaptador do Strapi.
const CONN = "api::opapingou-connection.opapingou-connection";
const EVENT = "api::event.event";

const strapiConnectionsDb = (strapi) => {
  const conns = () => strapi.db.query(CONN);
  const events = () => strapi.db.query(EVENT);
  return {
    findEventByUuid: (uuid) =>
      events().findOne({
        where: { uuid },
        select: ["id", "uuid", "opapingou_legacy"],
        populate: { opapingou_connection: true },
      }),
    setEventConnection: (eventId, connectionId, extra = {}) =>
      events().update({ where: { id: eventId }, data: { opapingou_connection: connectionId, ...extra } }),
    findConnectionByPublicId: (publicId) => conns().findOne({ where: { public_id: publicId } }),
    // A mais recente: se o endpoint de uma conexão sumiu, a seguinte da mesma empresa é a que vale.
    findActiveConnectionByCompany: (companyId, testMode) =>
      conns().findOne({ where: { company_id: companyId, test_mode: testMode, status: "active" }, orderBy: { id: "desc" } }),
    createConnection: (data) => conns().create({ data }),
    updateConnection: (id, data) => conns().update({ where: { id }, data }),
    deleteConnection: (id) => conns().delete({ where: { id } }),
    listConnections: () =>
      conns().findMany({ where: { status: "active" }, populate: { events: { select: ["uuid"] } }, orderBy: { createdAt: "desc" } }),
    countOpenPayments: (eventId, now) =>
      strapi.db.query("api::payment.payment").count({
        where: { event: eventId, status: "PEDING_PAYMENT", expires_at: { $gt: now } },
      }),
  };
};

module.exports = {
  createConnections,
  chargeConnectionFor,
  strapiConnectionsDb,
  ConnectionError,
  maskCnpj,
  toSummary,
  WEBHOOK_EVENTS,
};
