"use strict";

// Conexões Opa Pingou por evento (REA-12). Quem pode mexer em qual evento é decidido no BFF
// (Admin ou community-manager organizador); aqui as rotas só aceitam o token de integração.
// Respostas e logs nunca trazem a chave, o whsec_ nem o corpo recebido.

const { createCoreController } = require("@strapi/strapi").factories;
const { createOpaPingou } = require("../../../datasources/opapingou");
const { createSecretBox } = require("../../../utils/secret-box");
const { createConnections, strapiConnectionsDb, ConnectionError } = require("../services/connections");

const UID = "api::opapingou-connection.opapingou-connection";
const MAX_BODY_BYTES = 1024 * 1024;

const service = (strapi) =>
  createConnections({
    db: strapiConnectionsDb(strapi),
    makeClient: (apiKey) => createOpaPingou(apiKey === undefined ? {} : { apiKey }),
    box: createSecretBox(),
    log: strapi.log,
  });

module.exports = createCoreController(UID, ({ strapi }) => {
  const run = async (ctx, name, fn) => {
    try {
      return ctx.send(await fn(service(strapi)), 200);
    } catch (err) {
      if (err instanceof ConnectionError) {
        return ctx.send({ error: { code: err.code, message: err.userMessage, ...err.extra } }, err.status);
      }
      strapi.log.error(`[opapingou] conexão ${name} falhou: ${(err && err.code) || (err && err.name) || "erro"}`);
      return ctx.send({ error: { code: "INTERNAL", message: "Erro inesperado." } }, 500);
    }
  };

  return {
    list: (ctx) => run(ctx, "list", (svc) => svc.list().then((data) => ({ data }))),

    forEvent: (ctx) => run(ctx, "forEvent", (svc) => svc.forEvent(ctx.params.eventUuid)),

    connect(ctx) {
      const body = ctx.request.body || {};
      return run(ctx, "connect", async (svc) => ({
        connection: await svc.connect({
          eventUuid: body.event_uuid,
          apiKey: body.api_key,
          createdBy: body.created_by ? String(body.created_by).slice(0, 255) : null,
          createdByName: body.created_by_name ? String(body.created_by_name).slice(0, 255) : null,
        }),
      }));
    },

    attach: (ctx) =>
      run(ctx, "attach", async (svc) => ({
        connection: await svc.attach({ eventUuid: ctx.params.eventUuid, publicId: ctx.params.publicId }),
      })),

    detach: (ctx) => run(ctx, "detach", (svc) => svc.detach({ eventUuid: ctx.params.eventUuid })),

    // O BFF repassa o corpo cru (base64) e o Opa-Signature; o segredo nunca sai daqui.
    verify(ctx) {
      const body = ctx.request.body || {};
      const raw = typeof body.raw_body === "string" ? Buffer.from(body.raw_body, "base64") : null;
      if (!raw || raw.length > MAX_BODY_BYTES) return ctx.send({ error: { code: "INVALID_BODY" } }, 400);
      return run(ctx, "verify", (svc) =>
        svc.verifyWebhook({
          publicId: ctx.params.publicId,
          rawBody: raw,
          signature: typeof body.signature === "string" ? body.signature : "",
          nowS: Math.floor(Date.now() / 1000),
        })
      );
    },
  };
});
