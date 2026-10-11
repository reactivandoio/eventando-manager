"use strict";

// CPF da inscrição (REA-6): só dígitos, 11, dígitos verificadores conferidos.
// Nunca registre nem devolva o valor em mensagem de erro.

const digit = (digits, len) => {
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += Number(digits[i]) * (len + 1 - i);
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
};

const normalizeCpf = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return null;
  if (digit(digits, 9) !== Number(digits[9])) return null;
  if (digit(digits, 10) !== Number(digits[10])) return null;
  return digits;
};

module.exports = { normalizeCpf };
