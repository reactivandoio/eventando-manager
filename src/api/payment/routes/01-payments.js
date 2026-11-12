module.exports = {
  routes: [
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
    {
      // REA-34: aprovação manual de inscrição, sem cobrança. Sem `auth: false`: só o token de API
      // com acesso total (o do BFF, que confere se quem pede é admin) passa.
      method: "GET",
      path: "/payment/manual-approval/preview",
      handler: "payment.manualApprovalPreview",
    },
    {
      method: "POST",
      path: "/payment/manual-approval",
      handler: "payment.manualApproval",
    },
  ],
};
