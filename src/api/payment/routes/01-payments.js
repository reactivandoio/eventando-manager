module.exports = {
  routes: [
    {
      // Path defined with an URL parameter
      method: "POST",
      // Webhook do Pix Aí: o Pix Aí não manda token, então segue aberto; a resposta não
      // devolve mais a inscrição (REA-6: ela teria o CPF).
      path: "/payment/integration",
      handler: "payment.integration",
      config: {
        auth: false,
      },
    },
    {
      // Path defined with an URL parameter
      method: "POST",
      path: "/payment/email",
      handler: "payment.testEmail",
    },
    {
      // Path defined with an URL parameter
      method: "POST",
      path: "/payment/resend-email",
      handler: "payment.resendEmail",
    },
  ],
};
