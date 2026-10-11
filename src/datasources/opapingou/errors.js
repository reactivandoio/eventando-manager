"use strict";

// Erro do Opa Pingou sem a chave e sem o corpo: só o que dá para registrar e tratar.
class OpaPingouError extends Error {
  constructor({ status = null, code = "UNKNOWN", requestId = null, retryable = false } = {}) {
    super(`Opa Pingou: ${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "OpaPingouError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = retryable;
  }
}

// Erros de idempotência são erro nosso: não repete e alerta.
const IDEMPOTENCY_CODES = new Set(["IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_KEY_REQUIRED"]);

module.exports = { OpaPingouError, IDEMPOTENCY_CODES };
