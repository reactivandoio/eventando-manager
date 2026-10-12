'use strict';

const { markLegacyEvents } = require('./api/opapingou-connection/services/legacy');

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/*{ strapi }*/) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }) {
    try {
      await markLegacyEvents(strapi);
    } catch (err) {
      // Sem a marca, os eventos antigos não cobram (503): alerta e tenta de novo no próximo boot.
      strapi.log.error(`[ALERTA][opapingou] marcação dos eventos legados falhou: ${err && err.message}`);
    }
  },
};
