const test = require("node:test");
const assert = require("node:assert/strict");
const { legacyEventIds, markLegacyEvents } = require("../src/api/opapingou-connection/services/legacy");

const batch = (id, value, eventId) => ({ id, value, product: eventId ? { id: 1, event: { id: eventId } } : null });

test("legacyEventIds: eventos com lote de valor > 0, sem repetir", () => {
  assert.deepEqual(legacyEventIds([batch(1, 1000, 7), batch(2, 500, 7), batch(3, 0, 8), batch(4, 100, null), batch(5, "2000", 9)]), [7, 9]);
  assert.deepEqual(legacyEventIds(null), []);
});

const fakeStrapi = ({ marked = null, batches = [] } = {}) => {
  const calls = { updateMany: [], set: [] };
  return {
    calls,
    store: { get: async () => marked, set: async (v) => calls.set.push(v) },
    db: {
      query: (uid) => ({
        findMany: async () => (uid === "api::batch.batch" ? batches : []),
        updateMany: async (q) => calls.updateMany.push([uid, q]),
      }),
    },
    log: { info() {} },
  };
};

test("markLegacyEvents marca uma vez e grava a marca", async () => {
  const s = fakeStrapi({ batches: [batch(1, 1000, 7)] });
  assert.deepEqual(await markLegacyEvents(s), { marked: 1 });
  assert.deepEqual(s.calls.updateMany[0], ["api::event.event", { where: { id: { $in: [7] } }, data: { opapingou_legacy: true } }]);
  assert.equal(s.calls.set[0].key, "rea12_legacy_marked");

  const again = fakeStrapi({ marked: { at: "x" }, batches: [batch(1, 1000, 7)] });
  assert.deepEqual(await markLegacyEvents(again), { skipped: true });
  assert.equal(again.calls.updateMany.length, 0);
});
