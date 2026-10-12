"use strict";

/**
 * payment controller
 */

// d012e1f543eb327286ad1f5001cac58d9b26347a4f5c714217630b4013940a1529d6ad55ec7f22147e9f7df6a1957fb3cebdb8902a2ad0561b77e0dcfde2fd20b75f23818f7283c42f1fada843213722e6297f1dd877a064fe3bc3a427590f3877682af00d99747f783a68dc0b4c64427d0a86486d0805d972090e94aa300b7d

const { createCoreController } = require("@strapi/strapi").factories;

module.exports = createCoreController("api::payment.payment", ({ strapi }) => {
  const paymentIntegrationService = strapi.service(
    "api::payment-integration.payment-integration"
  );

  const paymentService = strapi.service("api::payment.payment");

  const signupService = strapi.service("api::signup.signup");

  const sendMail = async (itemToMail) => {
    try {
      const response = await strapi.plugin("email-designer").service("email").sendTemplatedEmail(
        {
          // required
          to: itemToMail.email,

          // optional if /config/plugins.js -> email.settings.defaultFrom is set
          from: "Pedro do Join Community <contato@8020digital.com.br>",

          // // optional if /config/plugins.js -> email.settings.defaultReplyTo is set
          // replyTo: "reply@example.com",

          // // optional array of files
          // attachments: [],
        },
        {
          // required - Ref ID defined in the template designer (won't change on import)
          templateReferenceId: itemToMail.templateReferenceId,

          // If provided here will override the template's subject.
          // Can include variables like `Thank you for your order {{= USER.firstName }}!`
          // subject: `Thank you for your order`,
        },
        {
          // this object must include all variables you're using in your email template
          name: itemToMail.name,
          totalValue: itemToMail.totalValue,
          tshirtSize: itemToMail.tshirtSize,
        }
      );

      console.log("send mailresponse: ", response);
    } catch (err) {
      strapi.log.debug("📺: ", err);
      // return ctx.badRequest(null, err);
    }
  };

  const buildItemToMail = (payment) => {
    const tshirtSizes = {
      XS: "Muito pequeno",
      S: "Pequeno",
      M: "Médio",
      L: "Grande",
      XL: "Muito grande",
    };

    const value = Number(payment.value);
    const templateReferenceId = value < 14000 ? 2 : 1;
    const name = payment.signup.name;
    const email = payment.signup.email;
    const totalValue = `R$ ${Number(value / 100)
      .toFixed(2)
      .replace(".", ",")}`;
    const tshirtSize = tshirtSizes[payment.signup.t_shirt_size];

    const itemToMail = {
      templateReferenceId,
      name,
      email,
      totalValue,
      tshirtSize,
    };

    return itemToMail;
  };

  return {
    async integration(ctx) {
      const { body } = ctx.request;

      paymentIntegrationService.create({
        data: {
          payload: body,
        },
      });

      if (body.event === "payment_initiation/completed") {
        let paymentEntry = null;

        try {
          const response = await paymentService.find({
            filters: {
              payment_identification: body.payload.payment_identification,
            },
            populate: ["signup"],
          });

          paymentEntry = response.results[0];
        } catch (err) {
          return ctx.send("Error on load payment", 400);
        }

        const itemToMail = buildItemToMail(paymentEntry);

        sendMail(itemToMail);

        try {
          await paymentService.update(paymentEntry.id, {
            data: {
              status: "CONFIRMED",
              confirmed_at: new Date(),
            },
          });
        } catch (err) {
          return ctx.send("Error on update payment", 400);
        }

        return ctx.send({ status: "CONFIRMED", payment_id: paymentEntry.id }, 200);
      }

      return ctx.send({ message: "event not found" }, 404);
    },

    async resendEmail(ctx) {
      const { payment_identification } = ctx.request.body;

      let paymentEntry = null;

      try {
        const response = await paymentService.find({
          filters: {
            payment_identification: payment_identification,
          },
          populate: ["signup"],
        });

        paymentEntry = response.results[0];
      } catch (err) {
        return ctx.send("Error on load payment", 400);
      }

      const itemToMail = buildItemToMail(paymentEntry);

      sendMail(itemToMail);

      return ctx.send({ message: "Email sent" }, 200);
    },

    async testEmail(ctx) {
      const { body } = ctx.request;

      const { email } = body;

      let payments = [];

      try {
        payments = await paymentService.find({
          filters: {
            status: "CONFIRMED",
          },
          populate: ["signup", "event"],
          pagination: {
            page: 2,
            pageSize: 25,
          },
        });

        console.log("payments: ", payments);

        // return ctx.send(payments, 200);
      } catch (err) {
        // return ctx.send(err, 400);

        console.log("err: ", err);
      }

      let itemsToMail = [];

      if (payments?.results?.length) {
        payments.results.forEach((payment) => {
          const itemToMail = buildItemToMail(payment);

          itemsToMail.push(itemToMail);
        });
      }

      // itemsToMail.forEach((itemToMail) => sendMail(itemToMail));

      return ctx.send(itemsToMail, 200);
    },
  };
});
