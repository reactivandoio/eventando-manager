"use strict";

// Cifragem das credenciais do Opa Pingou (REA-12): AES-256-GCM com a chave mestra
// OPAPINGOU_CREDENTIALS_KEY (32 bytes em base64). O contexto (id público da conexão + campo) entra
// como AAD: um valor copiado para outra conexão ou outro campo não abre. Formato:
// v1.<iv>.<tag>.<texto cifrado>, tudo em base64url. Erros nunca levam o texto aberto nem o cifrado.

const crypto = require("node:crypto");

const VERSION = "v1";

class SecretBoxError extends Error {
  constructor(code) {
    super(`Cofre de credenciais: ${code}`);
    this.name = "SecretBoxError";
    this.code = code;
  }
}

const keyFrom = (raw) => {
  if (!raw) throw new SecretBoxError("CREDENTIALS_KEY_MISSING");
  const key = Buffer.from(String(raw), "base64");
  if (key.length !== 32) throw new SecretBoxError("CREDENTIALS_KEY_INVALID");
  return key;
};

const createSecretBox = ({ key = process.env.OPAPINGOU_CREDENTIALS_KEY } = {}) => ({
  seal(plain, context) {
    const k = keyFrom(key);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
    cipher.setAAD(Buffer.from(String(context), "utf8"));
    const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, ct].map((p) => (Buffer.isBuffer(p) ? p.toString("base64url") : p)).join(".");
  },

  open(sealed, context) {
    const k = keyFrom(key);
    const parts = String(sealed || "").split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError("SEALED_VALUE_INVALID");
    try {
      const [, iv, tag, ct] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, "base64url")));
      const decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
      decipher.setAAD(Buffer.from(String(context), "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch (err) {
      throw new SecretBoxError("SEALED_VALUE_INVALID");
    }
  },
});

module.exports = { createSecretBox, SecretBoxError };
