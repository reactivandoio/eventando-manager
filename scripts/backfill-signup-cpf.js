// Backfill do CPF das inscrições antigas (REA-6). Copia o CPF da conta do Hub ou do sw-form com o
// mesmo e-mail (regra do withCpf do BFF), só onde o CPF está vazio e só CPF válido.
//
// Por padrão SIMULA e imprime só contagens (nunca CPF nem e-mail). Grava só com --apply, e só com
// ok do Pedro. Rodar no servidor, no diretório do projeto, com o .env carregado:
//
//   MANAGER_URL=https://manager.hubcommunity.io MANAGER_TOKEN=... node scripts/backfill-signup-cpf.js
//   ... node scripts/backfill-signup-cpf.js --apply
//
// MANAGER_TOKEN: token de integração do Hub (o mesmo MANAGER_TOKEN_INTEGRATION do BFF), passado
// só na linha de comando desta execução; não vai para o .env do Eventando.
// O .env do projeto é lido pelo próprio Strapi ao carregar.

const axios = require("axios");
const { planBackfill, normalizeEmail } = require("../src/utils/cpf-backfill");

const APPLY = process.argv.includes("--apply");
const CHUNK = 50;

const manager = () => {
  const base = String(process.env.MANAGER_URL || "").replace(/\/+$/, "");
  const token = process.env.MANAGER_TOKEN;
  if (!base || !token) throw new Error("Defina MANAGER_URL e MANAGER_TOKEN.");
  return (path) =>
    axios
      .get(`${base}/api${path}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 })
      .then((r) => (Array.isArray(r.data) ? r.data : r.data?.data || []));
};

const fetchByEmails = async (get, emails) => {
  const users = [];
  const forms = [];
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);
    const u = new URLSearchParams();
    chunk.forEach((e, n) => u.append(`filters[email][$in][${n}]`, e));
    u.append("pagination[pageSize]", "100");
    ["email", "cpf"].forEach((f, n) => u.append(`fields[${n}]`, f));
    users.push(...(await get(`/users?${u}`)));
    const f = new URLSearchParams();
    chunk.forEach((e, n) => f.append(`filters[$or][${n}][email][$eqi]`, e));
    f.append("pagination[pageSize]", "100");
    ["email", "cpf"].forEach((x, n) => f.append(`fields[${n}]`, x));
    forms.push(...(await get(`/sw-forms?${f}`)));
  }
  return { users, forms };
};

(async () => {
  const get = manager();
  const strapi = await require("@strapi/strapi")({ appDir: process.cwd(), distDir: process.cwd() }).load();
  try {
    const signups = await strapi.db.query("api::signup.signup").findMany({
      where: { $or: [{ cpf: { $null: true } }, { cpf: "" }] },
      select: ["id", "email", "cpf"],
    });
    const emails = [...new Set(signups.map((s) => normalizeEmail(s.email)).filter(Boolean))];
    const { users, forms } = await fetchByEmails(get, emails);
    const { updates, skipped } = planBackfill(signups, users, forms);

    console.log(`Inscrições sem CPF: ${signups.length}`);
    console.log(`A preencher: ${updates.length}`);
    console.log(`Sem CPF encontrado: ${skipped.noMatch}; CPF inválido na origem: ${skipped.invalid}`);
    if (!APPLY) {
      console.log("Simulação: nada foi gravado. Rode com --apply para gravar.");
      return;
    }
    let written = 0;
    for (const { id, cpf } of updates) {
      const { count } = await strapi.db.query("api::signup.signup").updateMany({
        where: { id, $or: [{ cpf: { $null: true } }, { cpf: "" }] },
        data: { cpf },
      });
      written += count;
    }
    console.log(`Gravadas: ${written}`);
  } finally {
    await strapi.destroy();
  }
})().catch((err) => {
  console.error(`Falhou: ${err.message}`);
  process.exit(1);
});
