// organ.test.mjs — v0 acceptance suite for the Cell-Organ Snapshot & Boot
// protocol (lane 63-c). Run: node --test test/
//
// Law under test (docs/REVERSE-ACTUALIZED-SPEC.md §4): every failure mode is
// fail-closed with an exact code; boot never partially succeeds.

import test from "node:test";
import assert from "node:assert/strict";

import {
  GENESIS,
  canonicalJson,
  computeManifestHash,
  makeReceipt,
  receiptHash,
  validateManifest,
  verifyChain,
} from "../src/organ/manifest.mjs";
import { makeQuilt, quiltApply, applyOp, verifyQuiltLedger } from "../src/organ/toyQuilt.mjs";
import { snapshot, snapshotOrgan, cellsStateHash, cellStateHash } from "../src/organ/snapshot.mjs";
import { boot, OrganBootError, verifyBundle } from "../src/organ/boot.mjs";
import { nestInto, verifyDoubleEntry } from "../src/organ/nest.mjs";
import { buildGreeterQuilt, GREETER_FINAL_OUT, GREETER_RECEIPTS, GREETER_EDGES } from "../examples/greeter-organ.mjs";

const GREETER_CELLS = ["greeting", "subject", "template", "out"];

function snapshotGreeter(quilt = buildGreeterQuilt(), opts = {}) {
  return snapshot(quilt.cells, opts.ledger ?? quilt.ledger, {
    name: "greeter-organ",
    edges: GREETER_EDGES,
    cellIds: opts.cellIds,
    organId: opts.organId,
    supersedes: opts.supersedes,
  });
}

const bootCode = (bundle, opts = {}) => {
  try {
    boot(bundle, opts);
  } catch (e) {
    if (e instanceof OrganBootError) return e.code;
    throw e;
  }
  return null; // booted — caller asserts otherwise
};

// ---------------------------------------------------------------------------
// substrate determinism
// ---------------------------------------------------------------------------

test("canonicalJson is deterministic and sorted; refuses undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, 1], c: "x" } }), '{"a":{"c":"x","d":[2,1]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: undefined }), TypeError);
  assert.throws(() => canonicalJson({ a: () => 1 }), TypeError);
  assert.throws(() => canonicalJson({ a: NaN }), TypeError);
});

test("receipt hashing is content-bound: any payload change changes the hash", () => {
  const r1 = makeReceipt(0, { type: "set", cellId: "x", value: 1 }, GENESIS);
  const r2 = makeReceipt(0, { type: "set", cellId: "x", value: 2 }, GENESIS);
  const r3 = makeReceipt(0, { type: "set", cellId: "x", value: 1 }, GENESIS);
  assert.notEqual(r1.hash, r2.hash);
  assert.equal(r1.hash, r3.hash);
  assert.equal(receiptHash(r1), r1.hash);
});

test("toy quilt: cells only change through receipts; ledger chain verifies", () => {
  const q = buildGreeterQuilt();
  const v = verifyQuiltLedger(q);
  assert.equal(v.ok, true);
  assert.equal(q.ledger.length, GREETER_RECEIPTS);
  assert.equal(q.cells.out.value, GREETER_FINAL_OUT);
  // unknown op refused, ledger untouched
  assert.throws(() => quiltApply(q, { type: "explode" }));
  assert.equal(q.ledger.length, GREETER_RECEIPTS);
});

// ---------------------------------------------------------------------------
// I1 content addressing
// ---------------------------------------------------------------------------

test("snapshot is content-addressed: identical inputs → identical manifestHash", () => {
  const q = buildGreeterQuilt();
  const b1 = snapshotGreeter(q);
  const b2 = snapshotGreeter(buildGreeterQuilt());
  assert.equal(b1.manifest.manifestHash, b2.manifest.manifestHash);
  assert.equal(b1.manifest.state.cellsSha256, b2.manifest.state.cellsSha256);
  // any state change → different address
  const q2 = buildGreeterQuilt();
  quiltApply(q2, { type: "set", cellId: "subject", value: "changed" });
  const b3 = snapshotGreeter(q2);
  assert.notEqual(b1.manifest.state.cellsSha256, b3.manifest.state.cellsSha256);
  assert.equal(b3.manifest.receiptRange.count, GREETER_RECEIPTS + 1);
});

test("per-cell stateHashes cover the carried state exactly", () => {
  const b = snapshotGreeter();
  assert.deepEqual(b.manifest.cells.map((c) => c.id), [...GREETER_CELLS].sort()); // canonical: sorted ids
  for (const c of b.manifest.cells) {
    assert.equal(cellStateHash(b.state.cells[c.id]), c.stateHash); // hash covers {kind,value}; id is the manifest entry's own field
  }
  assert.equal(cellsStateHash(b.state.cells), b.manifest.state.cellsSha256);
});

// ---------------------------------------------------------------------------
// happy path boot
// ---------------------------------------------------------------------------

test("happy path: snapshot → boot (no host) → verified organ wakes", () => {
  const b = snapshotGreeter();
  const organ = boot(b);
  assert.equal(organ.cells.out.value, GREETER_FINAL_OUT);
  assert.equal(organ.organId, b.manifest.organId);
  assert.equal(organ.ledger.length, GREETER_RECEIPTS);
  assert.equal(organ.host, null);
  // a standalone organ can keep appending (no credits, own chain only)
  const { debit, credit } = organ.append({ type: "set", cellId: "subject", value: "solo" });
  assert.equal(debit.seq, GREETER_RECEIPTS);
  assert.equal(credit, null);
  assert.equal(organ.cells.subject.value, "solo");
});

test("verifyBundle returns ok with tip hash; matches boot's verdict", () => {
  const b = snapshotGreeter();
  const v = verifyBundle(b);
  assert.equal(v.ok, true);
  assert.equal(v.tipHash, b.receipts[b.receipts.length - 1].hash);
});

// ---------------------------------------------------------------------------
// tamper detection — fail-closed
// ---------------------------------------------------------------------------

test("tamper: one flipped state byte → STATE_HASH_MISMATCH (fail-closed)", () => {
  const b = snapshotGreeter();
  b.state.cells.out.value = GREETER_FINAL_OUT.replace("!", "?");
  assert.equal(bootCode(b), "STATE_HASH_MISMATCH");
});

test("tamper: one flipped receipt payload byte → RECEIPT_HASH_MISMATCH", () => {
  const b = snapshotGreeter();
  b.receipts[5].op.value = "FL33T";
  assert.equal(bootCode(b), "RECEIPT_HASH_MISMATCH");
});

test("tamper: manifest cell hash flip → MANIFEST_INVALID; self-hash flip → MANIFEST_INVALID", () => {
  const b1 = snapshotGreeter();
  b1.manifest.cells[0].stateHash = "0".repeat(64);
  assert.equal(bootCode(b1), "MANIFEST_INVALID");

  const b2 = snapshotGreeter();
  b2.manifest.manifestHash = "0".repeat(64);
  assert.equal(bootCode(b2), "MANIFEST_INVALID");
});

// ---------------------------------------------------------------------------
// chain gap — fail-closed
// ---------------------------------------------------------------------------

test("chain gap: deleting one middle receipt refuses boot with CHAIN_GAP", () => {
  const b = snapshotGreeter();
  b.receipts.splice(7, 1); // drop seq 7
  const code = bootCode(b);
  assert.equal(code, "CHAIN_GAP");
});

test("chain gap: truncated tail (missing receipts) refuses with CHAIN_GAP", () => {
  const b = snapshotGreeter();
  b.receipts.pop(); // range says 12, carried 11
  assert.equal(bootCode(b), "CHAIN_GAP");
});

// ---------------------------------------------------------------------------
// replay divergence — the anti-forgery invariant
// ---------------------------------------------------------------------------

test("replay divergence: self-consistent forged chain with stale state fails closed", () => {
  const b = snapshotGreeter();
  // Forge: change seq 9's payload, then re-hash + re-chain EVERYTHING after —
  // the receipt chain is now internally perfect, the carried state is stale.
  b.receipts[9].op.value = "Fleet";
  for (let i = 9; i < b.receipts.length; i++) {
    if (i > 9) b.receipts[i].prev = b.receipts[i - 1].hash;
    b.receipts[i].hash = receiptHash(b.receipts[i]);
  }
  // sanity: the forged chain alone verifies
  assert.equal(verifyChain(b.receipts, { expectedStart: 0, expectedPrev: GENESIS }).ok, true);
  assert.equal(bootCode(b), "REPLAY_DIVERGENCE");
});

test("replay divergence: manifest hash untouched, so only replay can catch the forgery", () => {
  // Same forgery, but manifest.manifestHash also recomputed over forged cells —
  // STILL refused, because replay (not trust) defines state.
  const b = snapshotGreeter();
  b.receipts[9].op.value = "Fleet";
  for (let i = 9; i < b.receipts.length; i++) {
    if (i > 9) b.receipts[i].prev = b.receipts[i - 1].hash;
    b.receipts[i].hash = receiptHash(b.receipts[i]);
  }
  b.manifest.manifestHash = computeManifestHash(b.manifest);
  assert.equal(bootCode(b), "REPLAY_DIVERGENCE");
});

test("replay invalid op: a receipt referencing a missing cell refuses boot", () => {
  const b = snapshotGreeter();
  b.receipts.splice(0, 1); // remove greeting's init; render at seq 4 then breaks
  // splice shifts seqs → chain gap is detected first (fail-closed, earliest gate)
  assert.equal(bootCode(b), "CHAIN_GAP");
});

// ---------------------------------------------------------------------------
// schema drift — fail-closed
// ---------------------------------------------------------------------------

test("schema drift: unknown schemaVersion / wrong schema refuses boot", () => {
  const b1 = snapshotGreeter();
  b1.manifest.schemaVersion = 2;
  b1.manifest.manifestHash = computeManifestHash(b1.manifest);
  assert.equal(bootCode(b1), "SCHEMA_DRIFT");

  const b2 = snapshotGreeter();
  b2.manifest.schema = "quilt.organ.manifest.pro";
  b2.manifest.manifestHash = computeManifestHash(b2.manifest);
  assert.equal(bootCode(b2), "SCHEMA_DRIFT");
});

// ---------------------------------------------------------------------------
// custody: GENESIS vs trusted checkpoint
// ---------------------------------------------------------------------------

test("custody: organ extracted from a shared ledger needs a checkpoint; refuses without", () => {
  // A shared quilt: 2 unrelated receipts first, then the greeter's 12.
  const shared = makeQuilt("shared-quilt");
  quiltApply(shared, { type: "init", cellId: "unrelated", kind: "value", value: "do-not-carry" });
  quiltApply(shared, { type: "set", cellId: "unrelated", value: "still-unrelated" });
  const greeter = buildGreeterQuilt();
  for (const r of greeter.ledger) {
    quiltApply(shared, r.op); // replay greeter ops onto the shared quilt
  }
  assert.equal(shared.ledger.length, 2 + GREETER_RECEIPTS);

  // Extract the organ: state = greeter cells, ledger = seq 2..13 only.
  const b = snapshot(shared.cells, shared.ledger.slice(2), {
    name: "greeter-organ",
    edges: GREETER_EDGES,
    cellIds: GREETER_CELLS,
  });
  assert.equal(b.manifest.receiptRange.start, 2);
  assert.equal(b.manifest.genesis.seq, 2);
  assert.equal(b.manifest.genesis.prevHash, shared.ledger[1].hash);

  // No checkpoint → CUSTODY_GAP (an unverifiable prefix is unowned history)
  assert.equal(bootCode(b), "CUSTODY_GAP");

  // Wrong checkpoint → CUSTODY_CHECKPOINT_MISMATCH
  assert.equal(bootCode(b, { trustedCheckpoint: { seq: 1, hash: "0".repeat(64) } }), "CUSTODY_CHECKPOINT_MISMATCH");
  assert.equal(bootCode(b, { trustedCheckpoint: { seq: 5, hash: shared.ledger[1].hash } }), "CUSTODY_CHECKPOINT_MISMATCH");

  // Pinned correctly → boots, state proven by replay from empty cells
  const organ = boot(b, { trustedCheckpoint: { seq: 1, hash: shared.ledger[1].hash } });
  assert.equal(organ.cells.out.value, GREETER_FINAL_OUT);
  assert.equal(organ.ledger[0].seq, 2);
});

// ---------------------------------------------------------------------------
// nesting round-trip: snapshot → boot in fresh host → continue → re-snapshot → boot again
// ---------------------------------------------------------------------------

test("nesting round-trip: organ migrates across two hosts with intact custody", () => {
  const b1 = snapshotGreeter();
  const host1 = makeQuilt("host-A");
  quiltApply(host1, { type: "init", cellId: "host-cell", kind: "value", value: "A" });

  const organ1 = boot(b1, { host: host1 });
  assert.ok(host1.ledger.some((r) => r.op.type === "organ.nest"));

  // Continue: 4 debits net back to the identical state.
  organ1.append({ type: "set", cellId: "subject", value: "organ" });
  organ1.append({ type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] });
  organ1.append({ type: "set", cellId: "subject", value: "SuperInstance" });
  organ1.append({ type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] });

  const de1 = verifyDoubleEntry(host1, organ1);
  assert.equal(de1.ok, true, JSON.stringify(de1.errors));
  assert.equal(de1.creditsChecked, 4);

  // Host chain (with organ.* pointer receipts) still verifies and replays.
  assert.equal(verifyQuiltLedger(host1).ok, true);
  const replayedHost = {};
  for (const r of host1.ledger) applyOp(replayedHost, r.op);
  assert.deepEqual(replayedHost, host1.cells);

  // Re-snapshot: same identity, longer chain, supersedes pinned.
  const b2 = snapshotOrgan(organ1);
  assert.equal(b2.manifest.organId, b1.manifest.organId);
  assert.equal(b2.receipts.length, GREETER_RECEIPTS + 4);
  assert.equal(b2.manifest.supersedes, b1.manifest.manifestHash);

  // Boot again in a second fresh host — state hash BEFORE == AFTER.
  const host2 = makeQuilt("host-B");
  quiltApply(host2, { type: "init", cellId: "host-cell", kind: "value", value: "B" });
  const organ2 = boot(b2, { host: host2 });
  assert.equal(cellsStateHash(organ1.cells), cellsStateHash(organ2.cells));
  assert.equal(cellsStateHash(organ2.cells), b1.manifest.state.cellsSha256);
  assert.equal(organ2.cells.out.value, GREETER_FINAL_OUT);

  // The second host's double entry is balanced (0 new debits → 0 credits).
  const de2 = verifyDoubleEntry(host2, organ2);
  assert.equal(de2.ok, true, JSON.stringify(de2.errors));
  assert.equal(de2.creditsChecked, 0);
});

test("nesting: duplicate nest of the same manifest refuses with DUPLICATE_NEST", () => {
  const b = snapshotGreeter();
  const host = makeQuilt("host");
  const organ = boot(b); // no host
  nestInto(host, b, organ);
  assert.throws(() => nestInto(host, b, organ), (e) => e.code === "DUPLICATE_NEST");
});

test("nesting: a forged-but-self-consistent host credit is caught by double-entry", () => {
  const b = snapshotGreeter();
  const host = makeQuilt("host");
  const organ = boot(b, { host });
  organ.append({ type: "set", cellId: "subject", value: "X" });

  const forged = JSON.parse(JSON.stringify(host));
  const idx = forged.ledger.findIndex((r) => r.op.type === "organ.credit");
  forged.ledger[idx].op.stateHashAfter = "f".repeat(64);
  for (let i = idx; i < forged.ledger.length; i++) {
    if (i > idx) forged.ledger[i].prev = forged.ledger[i - 1].hash;
    forged.ledger[i].hash = receiptHash(forged.ledger[i]);
  }
  const de = verifyDoubleEntry(forged, { organId: organ.organId, ledger: organ.ledger, nestReceipt: organ.nestReceipt });
  assert.equal(de.ok, false);
  assert.ok(de.errors.some((e) => e.code === "DOUBLE_ENTRY_STATE_MISMATCH"));
});

test("nesting: a dropped host credit is unbalanced (debit without credit)", () => {
  const b = snapshotGreeter();
  const host = makeQuilt("host");
  const organ = boot(b, { host });
  organ.append({ type: "set", cellId: "subject", value: "X" });

  const robbed = JSON.parse(JSON.stringify(host));
  robbed.ledger = robbed.ledger.filter((r) => !(r.op.type === "organ.credit"));
  // seqs now have a hole → host chain itself is broken (also fail-closed)
  const de = verifyDoubleEntry(robbed, { organId: organ.organId, ledger: organ.ledger, nestReceipt: organ.nestReceipt });
  assert.equal(de.ok, false);
  assert.ok(de.errors.some((e) => e.code === "CHAIN_GAP" || e.code === "DOUBLE_ENTRY_UNBALANCED"));
});

// ---------------------------------------------------------------------------
// manifest validator details
// ---------------------------------------------------------------------------

test("validateManifest: edge to unknown cell and range inconsistency are MANIFEST_INVALID", () => {
  const b = snapshotGreeter();
  const bad1 = JSON.parse(JSON.stringify(b.manifest));
  bad1.edges = [{ from: "greeting", to: "ghost" }];
  bad1.manifestHash = computeManifestHash(bad1);
  assert.equal(validateManifest(bad1).ok, false);

  const bad2 = JSON.parse(JSON.stringify(b.manifest));
  bad2.receiptRange.count = 99;
  bad2.manifestHash = computeManifestHash(bad2);
  assert.equal(validateManifest(bad2).ok, false);
  assert.ok(validateManifest(bad2).errors.every((e) => e.code === "MANIFEST_INVALID"));
});

test("makeReceipt refuses malformed ops (fail-closed at the source)", () => {
  assert.throws(() => makeReceipt(-1, { type: "set" }, GENESIS));
  assert.throws(() => makeReceipt(0, { type: "" }, GENESIS));
  assert.throws(() => makeReceipt(0, { type: "set", value: undefined }, GENESIS), TypeError);
});
