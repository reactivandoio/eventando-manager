// REA-6: preview do preço com cupom, com o token de integração (sem auth: false).
module.exports = {
  routes: [{ method: "POST", path: "/coupon/preview", handler: "coupon.preview" }],
};
