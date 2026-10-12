"use strict";

// Cliente REST do Opa Pingou (REA-6). A chave opk_ só vive aqui, em memória: nunca em log,
// mensagem de erro ou resposta. Erros problem+json viram OpaPingouError pelo `code`, com o
// `requestId` no log. Repete só em 429, 5xx e erro de rede, com a mesma Idempotency-Key.
//
// Tudo cabe num prazo total (OPAPINGOU_DEADLINE_MS, padrão 40 s): a inscrição espera a cobrança
// dentro da requisição, e o proxy na frente do Eventando corta em 60 s (504). Sem prazo, 4
// tentativas de 15 s mais o recuo passavam de 60 s. Estourou o prazo: erro DEADLINE_EXCEEDED
// repetível; o pendente fica com a mesma chave e a nova tentativa recebe a mesma cobrança.

const axios = require("axios");
const { OpaPingouError, IDEMPOTENCY_CODES } = require("./errors");

const DEFAULT_URL = "https://api.opapingou.com.br";
const BACKOFF_MS = [1000, 2000, 4000];
const NIL_UUID = "00000000-0000-4000-8000-000000000000";

const defaultLog = {
  info: (...a) => (global.strapi ? strapi.log.info(...a) : console.log(...a)),
  error: (...a) => (global.strapi ? strapi.log.error(...a) : console.error(...a)),
};

const headerOf = (headers, name) => {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
};

const retryAfterMs = (headers, fallback) => {
  const raw = headerOf(headers, "retry-after");
  const s = Number(raw);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, 30000) : fallback;
};

const createOpaPingou = ({
  baseUrl = process.env.OPAPINGOU_API_URL || DEFAULT_URL,
  apiKey = process.env.OPAPINGOU_API_KEY,
  http = axios,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = defaultLog,
  alert = (msg) => log.error(`[ALERTA][opapingou] ${msg}`),
  timeout = 15000,
  deadlineMs = Number(process.env.OPAPINGOU_DEADLINE_MS) || 40000,
  now = () => Date.now(),
} = {}) => {
  const root = String(baseUrl).replace(/\/+$/, "");

  // retry: false para chamada que não é idempotente (cadastro de endpoint): repetir poderia criar
  // dois endpoints. Aí rede, 429 e 5xx viram erro na hora.
  // quiet: resposta de erro esperada (sondagem de escopos) vai para o log como info.
  const request = async (method, path, { data, idempotencyKey, retry = true, quiet = false } = {}) => {
    if (!apiKey) throw new OpaPingouError({ code: "API_KEY_MISSING" });
    const headers = { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
    if (data !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const started = now();
    const left = () => deadlineMs - (now() - started);
    const outOfTime = () => {
      log.error(`[opapingou] ${method} ${path} estourou o prazo de ${deadlineMs} ms`);
      return new OpaPingouError({ code: "DEADLINE_EXCEEDED", retryable: true });
    };
    // Espera antes de repetir, se ainda sobrar tempo para a espera e para mais uma tentativa.
    const waitOrGiveUp = async (ms) => {
      if (left() - ms < 1000) return false;
      await sleep(ms);
      return true;
    };

    for (let attempt = 0; ; attempt += 1) {
      const remaining = left();
      if (remaining < 1000) throw outOfTime();
      let res;
      const t0 = now();
      try {
        res = await http.request({
          method,
          url: `${root}${path}`,
          headers,
          data,
          timeout: Math.min(timeout, remaining),
          validateStatus: () => true,
        });
      } catch (err) {
        // Rede ou timeout: a cobrança pode ter sido criada; repete com a mesma chave.
        const code = err && err.code ? String(err.code) : "NETWORK_ERROR";
        log.error(
          `[opapingou] ${method} ${path} falhou na rede (${code}) em ${now() - t0} ms, tentativa ${attempt + 1}`
        );
        if (retry && attempt < BACKOFF_MS.length && (await waitOrGiveUp(BACKOFF_MS[attempt]))) continue;
        if (left() < 1000) throw outOfTime();
        throw new OpaPingouError({ code: "NETWORK_ERROR", retryable: true });
      }

      const body = res.data && typeof res.data === "object" ? res.data : {};
      const requestId = body.requestId || headerOf(res.headers, "x-request-id") || null;
      if (res.status >= 200 && res.status < 300) {
        const replayed = String(headerOf(res.headers, "idempotent-replayed") || "") === "true";
        log.info(
          `[opapingou] ${method} ${path} → HTTP ${res.status} em ${now() - t0} ms` +
            ` requestId=${requestId || "-"}${replayed ? " (replay)" : ""}`
        );
        return { status: res.status, data: res.data, replayed, requestId };
      }

      const code = body.code || `HTTP_${res.status}`;
      (quiet ? log.info : log.error)(
        `[opapingou] ${method} ${path} → HTTP ${res.status} em ${now() - t0} ms code=${code} requestId=${requestId || "-"}`
      );
      if (IDEMPOTENCY_CODES.has(code)) {
        alert(`erro de idempotência ${code} em ${method} ${path} (requestId ${requestId || "-"})`);
        throw new OpaPingouError({ status: res.status, code, requestId });
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retry && retryable && attempt < BACKOFF_MS.length) {
        const wait = res.status === 429 ? retryAfterMs(res.headers, BACKOFF_MS[attempt]) : BACKOFF_MS[attempt];
        if (await waitOrGiveUp(wait)) continue;
      }
      throw new OpaPingouError({ status: res.status, code, requestId, retryable });
    }
  };

  return {
    async me() {
      return (await request("GET", "/v1/me")).data;
    },
    // Corpo estrito do contrato: sem bankAccountId (o Opa Pingou escolhe a conta).
    async createCharge({ amountCents, validity = "FIFTEEN_MIN", description, kind = "PIX_QR", idempotencyKey }) {
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        throw new OpaPingouError({ code: "INVALID_AMOUNT" });
      }
      if (!idempotencyKey) throw new OpaPingouError({ code: "IDEMPOTENCY_KEY_REQUIRED" });
      const data = { amountCents, validity, kind };
      if (description) data.description = String(description).slice(0, 140);
      const res = await request("POST", "/v1/charges", { data, idempotencyKey });
      return { charge: res.data, replayed: res.replayed, requestId: res.requestId };
    },
    async getCharge(id) {
      return (await request("GET", `/v1/charges/${encodeURIComponent(id)}`)).data;
    },
    // Devolve o endpoint com o `secret` (whsec_), que o Opa Pingou só mostra aqui. Quem chama
    // guarda o segredo cifrado e nunca o registra.
    async createWebhookEndpoint({ url, description, events }) {
      const data = { url, events };
      if (description) data.description = String(description).slice(0, 120);
      return (await request("POST", "/v1/webhook-endpoints", { data, retry: false })).data;
    },
    // Quais dos escopos de cobrança e webhook a chave não tem, sem efeito colateral: no Opa Pingou o
    // ScopesGuard roda antes da validação, então sem o escopo vem 403 INSUFFICIENT_SCOPE e com ele
    // vem 400/404 (corpo vazio, cobrança inexistente). Nenhuma cobrança é criada.
    async missingScopes() {
      const probes = [
        ["charges:read", "GET", `/v1/charges/${NIL_UUID}`, undefined],
        ["charges:write", "POST", "/v1/charges", {}],
        ["webhooks:read", "GET", "/v1/webhook-endpoints", undefined],
      ];
      const missing = [];
      for (const [scope, method, path, data] of probes) {
        try {
          await request(method, path, { data, retry: false, quiet: true });
        } catch (err) {
          if (!(err instanceof OpaPingouError)) throw err;
          if (err.code === "INSUFFICIENT_SCOPE") missing.push(scope);
          else if (err.status === null || err.status === 401 || err.status === 429 || err.status >= 500) throw err;
        }
      }
      return missing;
    },
    async getWebhookEndpoint(id) {
      return (await request("GET", `/v1/webhook-endpoints/${encodeURIComponent(id)}`)).data;
    },
  };
};

const isEnabled = (env = process.env) => String(env.OPAPINGOU_ENABLED || "").toLowerCase() === "true";

module.exports = { createOpaPingou, isEnabled, OpaPingouError };
