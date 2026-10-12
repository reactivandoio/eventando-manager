// Sem rotas padrão de CRUD: só estas, todas com o token de integração (sem auth: false).
module.exports = {
  routes: [
    { method: "POST", path: "/opapingou/events", handler: "opapingou-event.store" },
    { method: "GET", path: "/opapingou/events/pending", handler: "opapingou-event.pending" },
    { method: "POST", path: "/opapingou/events/:eventId/process", handler: "opapingou-event.process" },
  ],
};
