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
  ],
};
