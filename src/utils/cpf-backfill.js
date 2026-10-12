"use strict";

// Backfill do CPF das inscrições antigas (REA-6), puro. Mesma regra do withCpf do BFF: a conta do
// Hub primeiro, depois o formulário do Startup Weekend (sw-form), pelo e-mail sem caixa e sem
// espaços. Só preenche CPF vazio e só com CPF válido.

const { normalizeCpf } = require("./cpf");

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

// rows: [{ email, cpf }] → Map(email → cpf válido), o primeiro válido vence.
const cpfByEmail = (rows) => {
  const map = new Map();
  for (const row of rows || []) {
    const email = normalizeEmail(row && row.email);
    const cpf = normalizeCpf(row && row.cpf);
    if (email && cpf && !map.has(email)) map.set(email, cpf);
  }
  return map;
};

const planBackfill = (signups, users, swForms) => {
  const fromUsers = cpfByEmail(users);
  const fromForms = cpfByEmail(swForms);
  const updates = [];
  const skipped = { alreadySet: 0, noMatch: 0, invalid: 0 };
  for (const s of signups) {
    if (s.cpf) {
      skipped.alreadySet += 1;
      continue;
    }
    const email = normalizeEmail(s.email);
    const cpf = fromUsers.get(email) || fromForms.get(email) || null;
    if (cpf) {
      updates.push({ id: s.id, cpf });
      continue;
    }
    const hadRaw = [...(users || []), ...(swForms || [])].some(
      (r) => normalizeEmail(r && r.email) === email && r.cpf
    );
    if (hadRaw) skipped.invalid += 1;
    else skipped.noMatch += 1;
  }
  return { updates, skipped };
};

module.exports = { planBackfill, cpfByEmail, normalizeEmail };
