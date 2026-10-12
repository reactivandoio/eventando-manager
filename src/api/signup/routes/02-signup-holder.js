module.exports = {
  routes: [
    {
      // REA-22: sem `auth: false` de propósito. Nenhum papel recebe a ação
      // api::signup.signup.holder; só um token de API com acesso total (o do BFF) passa.
      method: "POST",
      path: "/signup-holder/:id",
      handler: "signup.holder",
      config: {},
    },
  ],
};
