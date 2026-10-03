// FB6 pins — zeroclaw organ adapter (fleet-seeds spec deltas/2026-10-03-fb6-organ-custody-spec.md)
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootZeroclaw, snapshotZeroclaw, fnv1a64, pyCanon } from "../src/organ/zeroclawOps.mjs";
import { GENESIS } from "../src/organ/manifest.mjs";

// VERBATIM rows 0-1 of the shipped journal (fleet-seeds tools/zeroclaw/
// zeroclaw-journal.jsonl, tip d4e2194d8fd102e2) — captured programmatically,
// not transcribed. Row 0 is the v0 genesis (prev_hash null); row 1 is the
// first cited row. Lesson of the first pin draft: fabricated fixtures that
// merely LOOK right are worse than no pins.
const ROW0 = {
  "agent": "zeroclaw-v0",
  "latency_s": 32.223,
  "model": "MiniMax-M2.7",
  "order": "fleet-seeds-last3-scout-delta",
  "output_file": "2026-10-03-fleet-seeds-last3-scout-delta.md",
  "output_sha256": "198d410f40830a3092ae845d83e0e1b8630ff29981e99c827ede94cadf201a06",
  "prev_hash": null,
  "prompt_sha256": "075ed24631cffcbe16bd98c0095974048631d02752e3c4c5fbdf046633304136",
  "row_hash": "3d0e52b8b056327d",
  "ts": "2026-10-03T00:13:05Z",
  "usage": { "completion_tokens": 1200, "prompt_tokens": 4340, "total_characters": 0, "total_tokens": 5540 }
};
const ROW1 = {
  "agent": "zeroclaw-v0.5",
  "cites": [
    "git:e9363fa49548c12239da58745120e4fb59b61250",
    "tip:b92d3cd2e735e8f5fdad0c008446a93667aa4ee0c0a06c4bcb2a3e2bccf5f572"
  ],
  "latency_s": 22.642,
  "model": "MiniMax-M2.7",
  "order": "fleet-seeds-last3-scout-delta",
  "output_file": "2026-10-03-fleet-seeds-last3-scout-delta.md",
  "output_sha256": "dc435b3c98c8d5162ceb6f2c82c429ba7dff6eab9951fd976bc0cf4516b7084e",
  "prev_hash": "3d0e52b8b056327d",
  "prompt_sha256": "02072ca02196c7fa6e9a622c17adee31a394f7fadbaf91b6b14a2b3dedf9678c",
  "row_hash": "a96f34f56cc03f6b",
  "ts": "2026-10-03T04:39:09Z",
  "usage": { "completion_tokens": 1200, "prompt_tokens": 3003, "prompt_tokens_details": { "cached_tokens": 2683 }, "total_characters": 0, "total_tokens": 4203 }
};

test("FB6 pin 1: pyCanon+fnv1a64 are byte-compatible with zeroclaw.py (unicode probe)", () => {
  // Cross-checked against python3 zeroclaw.py on 2026-10-03: 0bb7ff71394cd3eb both sides.
  const probe = { order: "demo", ts: "2026-10-03T00:00:00Z", note: "héllo→世界\n" };
  assert.equal(pyCanon(probe), '{"note":"h\\u00e9llo\\u2192\\u4e16\\u754c\\n","order":"demo","ts":"2026-10-03T00:00:00Z"}');
  assert.equal(fnv1a64(pyCanon(probe)), "0bb7ff71394cd3eb");
});

test("FB6 pin 2: the shipped journal's real rows verify, chain, and boot", () => {
  const organ = bootZeroclaw([ROW0, ROW1], { name: "pin" });
  assert.equal(organ.custody.rows, 2);
  assert.equal(organ.custody.tip, "a96f34f56cc03f6b");
  assert.equal(organ.cells.journal.value.orders.length, 2);
  assert.equal(organ.manifest.receiptRange.count, 2);
  assert.equal(organ.ledger[0].prev, GENESIS); // null prev normalizes
  assert.equal(organ.ledger[1].prev, "3d0e52b8b056327d");
});

test("FB6 pin 3: one-field tamper refuses ZC_ROW_HASH_MISMATCH", () => {
  const tampered = [ROW0, { ...ROW1, latency_s: 9.9 }];
  assert.throws(() => bootZeroclaw(tampered), /ZC_ROW_HASH_MISMATCH/);
});

test("FB6 pin 4: a mid-chain row whose prev is not the predecessor's hash refuses (linkage named)", () => {
  // ROW0 replayed at row 2: its prev (null, genesis-shaped) is not ROW1's hash.
  assert.throws(() => bootZeroclaw([ROW0, ROW1, ROW0]), /ZC_CHAIN_BROKEN: row 2 prev null != row 1 hash a96f34f56cc03f6b/);
});

test("FB6 pin 5: a run()-style genesis row (prev_hash \"genesis\") also normalizes", () => {
  const op = (({ row_hash, prev_hash, ...rest }) => ({ ...rest, prev_hash: "genesis" }))(ROW0);
  const runStyle = { ...op, row_hash: fnv1a64(pyCanon(op)) };
  const organ = bootZeroclaw([runStyle], { name: "pin" });
  assert.equal(organ.ledger[0].prev, GENESIS);
});

test("FB6 pin 6: row 0 with a foreign prev refuses (unowned history, no checkpoint)", () => {
  const op = (({ row_hash, ...rest }) => ({ ...rest, prev_hash: "cafe0000cafe0000" }))(ROW0);
  const bad = { ...op, row_hash: fnv1a64(pyCanon(op)) }; // hash honest, anchor wrong
  assert.throws(() => bootZeroclaw([bad]), /ZC_CHAIN_BROKEN: genesis anchor/);
});

test("FB6 pin 7: a row missing a canonical field refuses ZC_SCHEMA_DRIFT", () => {
  const { latency_s, ...missing } = ROW1;
  assert.throws(() => bootZeroclaw([ROW0, { ...missing, row_hash: ROW1.row_hash }]),
    /ZC_SCHEMA_DRIFT: row 1 missing field 'latency_s'/);
});

test("FB6 pin 8: JEV canary rides the chain as a witness, never as state", () => {
  const plain = bootZeroclaw([ROW0, ROW1], { name: "pin" });
  const withC = bootZeroclaw([ROW0, ROW1], { name: "pin", canary: { question: "coherent custody?", answer: "yes", score: 0.91 } });
  assert.equal(withC.ledger.length, plain.ledger.length + 1);
  assert.equal(withC.ledger[2].type, "zeroclaw.canary");
  assert.equal(withC.cells.journal.value.tip, plain.cells.journal.value.tip); // state untouched
  assert.equal(withC.custody.canary.witness, true);
});

test("FB6 pin 9: empty journal refuses (no custody, no organ)", () => {
  assert.throws(() => snapshotZeroclaw([], { name: "pin" }), /ZC_SCHEMA_DRIFT: empty journal/);
});

test("FB6 pin 10: full shipped journal (8 rows) boots with the live tip", async () => {
  const { readFileSync } = await import("node:fs");
  const rows = readFileSync(new URL("./fixtures/zeroclaw-journal-8row.jsonl", import.meta.url), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const organ = bootZeroclaw(rows, { name: "fleet-zeroclaw" });
  assert.equal(rows.length, 8);
  assert.equal(organ.custody.tip, "d4e2194d8fd102e2");
  assert.equal(organ.cells.journal.value.models.includes("pincher-reflex"), true);
});
