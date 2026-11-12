"use strict";

/**
 * REA-36: the "Declaro que tenho 18 anos ou mais" checkbox of the Hub signup forms. The BFF requires
 * it and sends `adult_declaration: true`; the signup records when it was given. Without it the
 * signup is saved as before (the field stays null), so older callers keep working.
 */
const adultDeclarationFields = (body, now = new Date()) =>
  body && body.adult_declaration === true ? { adult_declaration_at: now } : {};

module.exports = { adultDeclarationFields };
