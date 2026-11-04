// Isolated fixture check for web/src/human-format.ts (compiled to JS first).
// Usage: node qa/human-format-check.mjs <compiled-human-format.js>
// No servers, no production data, no network.
import assert from "node:assert/strict";

const modPath = process.argv[2];
assert.ok(modPath, "pass the compiled human-format.js path");

const m = await import(modPath);

// 1. Valid payload parses with keys preserved.
{
  const json = JSON.stringify([{ id: "a1", text: "Approve plan" }, { id: "b2", text: "Decline lease" }]);
  const p = m.parseRecordItems(json);
  assert.equal(p.problem, null);
  assert.equal(p.items.length, 2);
  assert.equal(p.items[0].key, "a1");
  assert.equal(p.items[1].text, "Decline lease");
}

// 2. Unreadable / wrong-shape payloads never throw.
assert.equal(m.parseRecordItems("{oops").problem, "unreadable");
assert.equal(m.parseRecordItems("{}").problem, "not-a-list");
assert.equal(m.parseRecordItems("[]").problem, "empty");

// 3. Text round-trip: numbering stripped, keys follow text, new rows minted.
{
  const prev = [{ key: "a1", text: "Approve plan" }, { key: "b2", text: "Decline lease" }];
  const rt = m.editableTextToItems("2. Decline lease\nApprove plan\n1. Start hiring", prev);
  assert.equal(rt.items.length, 3);
  assert.equal(rt.items[0].key, "b2");
  assert.equal(rt.items[1].key, "a1");
  assert.ok(rt.items[2].key.startsWith("n-"));
  assert.equal(rt.added, 1);
  assert.equal(rt.removed, 0);
  const wire = JSON.parse(m.itemsToJson(rt.items));
  assert.deepEqual(Object.keys(wire[0]).sort(), ["id", "text"]);
}

// 4. Removed rows are counted, blank lines ignored.
{
  const prev = [{ key: "a1", text: "Keep me" }, { key: "b2", text: "Drop me" }];
  const rt = m.editableTextToItems("Keep me\n\n   ", prev);
  assert.equal(rt.items.length, 1);
  assert.equal(rt.removed, 1);
}

// 5. Statuses read human; no implementation words leak into labels.
{
  const labels = [
    m.friendlyRecordStatus("open", false).label,
    m.friendlyRecordStatus("partially-approved", false).label,
    m.friendlyRecordStatus("approved", true).label,
    m.friendlyRecordStatus("superseded", true).label,
  ];
  for (const label of labels) {
    assert.ok(!/json|hash|watermark|guid|payload|schema/i.test(label), "jargon in " + label);
  }
  assert.equal(labels[0], "Open for review");
}

// 6. Comparison headlines are Added/Removed/Updated with text first.
{
  const prev = JSON.stringify([{ id: "a1", text: "Old text" }, { id: "gone", text: "Vanished" }]);
  const cur = JSON.stringify([{ id: "a1", text: "New text" }, { id: "fresh", text: "Brand new" }]);
  const changes = m.describeItemChanges(prev, cur);
  const kinds = changes.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["added", "removed", "updated"]);
  for (const c of changes) assert.ok(c.detail.length > 0);
}

// 7. Friendly errors map to actionable copy; unknown stays unmapped.
{
  const mapped = m.friendlyError("Review is superseded; branch from the current successor instead.");
  assert.ok(mapped.indexOf("newer version") >= 0);
  assert.equal(m.friendlyError("Something completely novel 741"), "");
  assert.ok(m.shortRef("abcdef1234567890").length <= 8);
}

console.log("human-format fixtures: 7 groups passed");

