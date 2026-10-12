// Sem rotas padrão de CRUD: só estas, todas com o token de integração do BFF (sem auth: false).
module.exports = {
  routes: [
    { method: "GET", path: "/opapingou/connections", handler: "opapingou-connection.list" },
    { method: "POST", path: "/opapingou/connections", handler: "opapingou-connection.connect" },
    { method: "GET", path: "/opapingou/connections/event/:eventUuid", handler: "opapingou-connection.forEvent" },
    { method: "DELETE", path: "/opapingou/connections/event/:eventUuid", handler: "opapingou-connection.detach" },
    { method: "PUT", path: "/opapingou/connections/:publicId/events/:eventUuid", handler: "opapingou-connection.attach" },
    { method: "POST", path: "/opapingou/connections/:publicId/verify", handler: "opapingou-connection.verify" },
  ],
};
