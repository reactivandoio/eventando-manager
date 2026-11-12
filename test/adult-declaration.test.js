"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { adultDeclarationFields } = require("../src/utils/adult-declaration");

const now = new Date("2026-11-12T15:00:00.000Z");

test("records the date when the declaration is sent", () => {
  assert.deepEqual(adultDeclarationFields({ adult_declaration: true }, now), { adult_declaration_at: now });
});

test("records nothing without the declaration", () => {
  assert.deepEqual(adultDeclarationFields({}, now), {});
  assert.deepEqual(adultDeclarationFields({ adult_declaration: "true" }, now), {});
  assert.deepEqual(adultDeclarationFields(null, now), {});
});
