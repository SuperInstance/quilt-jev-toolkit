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
import { stateAt, rewind, transact, ORGAN_REWIND_TYPE } from "../src/organ/rewind.mjs";
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

// ===========================================================================
// v1 (lane 64-a) — the rewind family + write-side transactions
// ===========================================================================

const v1ErrorCode = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof OrganBootError) return e.code;
    throw e;
  }
  return null; // did not throw — caller asserts otherwise
};

/** Build a fresh greeter bundle advanced by the given extra ops (organ-append
 *  semantics on a standalone quilt, then re-snapshot). Deterministic. */
function advancedBundle(extraOps) {
  const quilt = buildGreeterQuilt();
  for (const op of extraOps) quiltApply(quilt, op);
  return snapshot(quilt.cells, quilt.ledger, { name: "greeter-organ", edges: GREETER_EDGES });
}

const ADVANCE_OPS = [
  { type: "set", cellId: "greeting", value: "Salutations" },
  { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] },
  { type: "set", cellId: "subject", value: "v1" },
  { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] },
];

// ---------------------------------------------------------------------------
// rewind round-trip: boot → advance → rewind to 0 == genesis state (byte-exact)
// ---------------------------------------------------------------------------

test("v1 rewind round-trip: rewind(bundle, 0) reproduces the genesis state byte-identically", () => {
  const b0 = snapshotGreeter();
  const b1 = advancedBundle(ADVANCE_OPS); // 12 + 4 = 16 receipts
  assert.equal(b1.manifest.receiptRange.count, GREETER_RECEIPTS + ADVANCE_OPS.length);

  // Independent genesis reference: apply ONLY receipt 0's op to empty cells.
  const genesisRef = {};
  applyOp(genesisRef, b1.receipts[0].op);

  const view = rewind(b1, 0);
  assert.equal(view.provenance.start, 0);
  assert.equal(view.provenance.end, 0);
  assert.equal(view.provenance.count, 1);
  assert.equal(view.provenance.tipHash, b1.receipts[0].hash);
  assert.equal(view.stateHash, cellsStateHash(genesisRef));
  assert.equal(canonicalJson(view.state), canonicalJson({ cells: genesisRef })); // byte-identical
  // ...and the input bundle is untouched (pure form)
  assert.equal(b1.receipts.length, GREETER_RECEIPTS + ADVANCE_OPS.length);

  // rewind to the pre-advance tip == the v0 snapshot's state (cross-check)
  const backToV0 = rewind(b1, GREETER_RECEIPTS - 1);
  assert.equal(backToV0.stateHash, b0.manifest.state.cellsSha256);
  // rewind to tip == carried state (identity)
  const atTip = rewind(b1, b1.manifest.receiptRange.end);
  assert.equal(atTip.stateHash, b1.manifest.state.cellsSha256);
});

test("v1 stateAt: time-travel query == independent prefix replay, pure on bundles and organs", () => {
  const b1 = advancedBundle(ADVANCE_OPS);
  for (const seq of [0, 3, 5, GREETER_RECEIPTS - 1, b1.manifest.receiptRange.end]) {
    const ref = {};
    for (let i = 0; i <= seq; i++) applyOp(ref, b1.receipts[i].op);
    const view = stateAt(b1, seq);
    assert.equal(view.stateHash, cellsStateHash(ref), `seq ${seq}`);
    assert.equal(canonicalJson(view.state), canonicalJson({ cells: ref }), `seq ${seq}`);
  }

  // purity: bundle bytes identical before/after; organ untouched
  const before = canonicalJson(b1);
  stateAt(b1, 7);
  assert.equal(canonicalJson(b1), before);

  const organ = boot(b1);
  const organBefore = canonicalJson({ ledger: organ.ledger, cells: organ.cells });
  const organView = stateAt(organ, 9);
  assert.equal(organView.stateHash, stateAt(b1, 9).stateHash);
  assert.equal(canonicalJson({ ledger: organ.ledger, cells: organ.cells }), organBefore);
  assert.equal(organ.ledger.length, b1.receipts.length);
});

test("v1 stateAt determinism: same seq → same hash across independent builds and runs", () => {
  const a = advancedBundle(ADVANCE_OPS);
  const bb = advancedBundle(ADVANCE_OPS); // rebuilt from scratch, byte-equal inputs
  assert.equal(a.manifest.manifestHash, bb.manifest.manifestHash);
  const seqs = [2, 8, 13, a.manifest.receiptRange.end];
  for (const s of seqs) {
    assert.equal(stateAt(a, s).stateHash, stateAt(bb, s).stateHash, `seq ${s}`);
    assert.equal(rewind(a, s).stateHash, stateAt(a, s).stateHash, `seq ${s}`);
  }
});

// ---------------------------------------------------------------------------
// rewind past a nest boundary: the compensating host-side credit (net zero)
// ---------------------------------------------------------------------------

test("v1 rewind past nest: host emits organ.rewind compensating receipt; double-entry nets to zero", () => {
  const b = snapshotGreeter();
  const host = makeQuilt("host-R");
  const organ = boot(b, { host });
  organ.append({ type: "set", cellId: "subject", value: "A" });
  organ.append({ type: "set", cellId: "subject", value: "B" });
  organ.append({ type: "set", cellId: "subject", value: "C" });
  const preTip = organ.ledger[organ.ledger.length - 1].seq; // GREETER_RECEIPTS + 2
  let de = verifyDoubleEntry(host, organ);
  assert.equal(de.ok, true);
  assert.equal(de.creditsChecked, 3);

  // Rewind PAST the nest boundary (nest pinned organSeq = GREETER_RECEIPTS - 1).
  const nestPinnedSeq = organ.nestReceipt.op.organSeq;
  const target = 4; // deep in the pre-nest history
  const result = rewind(organ, target);
  assert.equal(result.rewoundFrom, preTip);
  assert.equal(result.provenance.end, target);
  assert.equal(result.stateHash, stateAt(b, target).stateHash);

  // The compensating receipt: the reverse of the debit/credit pair.
  const comp = result.compensating;
  assert.ok(comp, "a rewind that revokes credits must emit a host receipt");
  assert.equal(comp.op.type, ORGAN_REWIND_TYPE);
  assert.equal(comp.op.organId, organ.organId);
  assert.equal(comp.op.fromSeq, preTip);
  assert.equal(comp.op.toSeq, target);
  assert.equal(comp.op.stateHashAfter, result.stateHash);
  assert.equal(comp.op.rewound.length, 3); // the three post-nest credits
  for (const w of comp.op.rewound) {
    const credit = host.ledger[w.creditSeq];
    assert.equal(credit.hash, w.creditHash);
    assert.equal(credit.op.debitHash, w.debitHash);
    assert.ok(w.organSeq > nestPinnedSeq, "revoked credits are the post-nest ones");
  }

  // Append-only: NOTHING was erased from the host ledger.
  assert.equal(host.ledger.filter((r) => r.op.type === "organ.credit").length, 3);
  assert.equal(host.ledger.filter((r) => r.op.type === ORGAN_REWIND_TYPE).length, 1);
  assert.equal(verifyQuiltLedger(host).ok, true);

  // Double-entry now nets to zero: 0 live debits vs 0 live credits (3 revoked).
  de = verifyDoubleEntry(host, organ);
  assert.equal(de.ok, true, JSON.stringify(de.errors));
  assert.equal(de.creditsChecked, 0);
  assert.equal(de.creditsRevoked, 3);
  assert.equal(de.rewinds, 1);

  // The organ continues from the rewound tip: next debit is seq target+1.
  const { debit, credit } = organ.append({ type: "set", cellId: "subject", value: "after-rewind" });
  assert.equal(debit.seq, target + 1);
  assert.ok(credit, "post-rewind debits get fresh host credits");
  de = verifyDoubleEntry(host, organ);
  assert.equal(de.ok, true, JSON.stringify(de.errors));
  assert.equal(de.creditsChecked, 1);

  // Re-snapshot the rewound organ → boots fresh, hash-equal to the rewind view.
  const b2 = snapshotOrgan(organ);
  assert.equal(b2.receipts.length, target + 2); // seq 0..target + the new debit
  const organ2 = boot(b2);
  assert.equal(cellsStateHash(organ2.cells), cellsStateHash(organ.cells));
});

test("v1 partial rewind (inside post-nest window): remaining credits still pair 1:1", () => {
  const b = snapshotGreeter();
  const host = makeQuilt("host-P");
  const organ = boot(b, { host });
  organ.append({ type: "set", cellId: "subject", value: "A" }); // debit seq 12
  organ.append({ type: "set", cellId: "subject", value: "B" }); // debit seq 13
  organ.append({ type: "set", cellId: "subject", value: "C" }); // debit seq 14
  const result = rewind(organ, GREETER_RECEIPTS + 1); // toSeq 13: keeps debits 12+13, revokes credit for 14
  assert.equal(result.compensating.op.rewound.length, 1);
  const de = verifyDoubleEntry(host, organ);
  assert.equal(de.ok, true, JSON.stringify(de.errors));
  assert.equal(de.creditsChecked, 2, "the two kept debits still pair with their credits");
  assert.equal(de.creditsRevoked, 1);
  // rewound cells == state as of the kept tip (subject was set A@12, B@13)
  assert.equal(organ.cells.subject.value, "B");
});

test("v1 rewind audit is fail-closed: forged rewind receipts are caught", () => {
  const b = snapshotGreeter();
  const host = makeQuilt("host-F");
  const organ = boot(b, { host });
  organ.append({ type: "set", cellId: "subject", value: "A" });
  organ.append({ type: "set", cellId: "subject", value: "B" });
  rewind(organ, GREETER_RECEIPTS); // toSeq 12: revokes the credit for debit 13
  assert.equal(verifyDoubleEntry(host, organ).ok, true);

  // Forge 1: attacker PADS the evidence list, listing a LIVE credit (whose
  // debit is still carried) as revoked, then re-hashes the tail. The pairing
  // law catches it: the debit loses its credit → UNBALANCED.
  const forged = JSON.parse(JSON.stringify(host));
  const rIdx = forged.ledger.findIndex((r) => r.op.type === ORGAN_REWIND_TYPE);
  const liveCredit = forged.ledger.find((r) => r.op.type === "organ.credit" && r.op.organSeq === GREETER_RECEIPTS);
  forged.ledger[rIdx].op.rewound.push({
    creditSeq: liveCredit.seq,
    creditHash: liveCredit.hash,
    organSeq: liveCredit.op.organSeq,
    debitHash: liveCredit.op.debitHash,
  });
  forged.ledger[rIdx].prev = forged.ledger[rIdx - 1].hash;
  forged.ledger[rIdx].hash = receiptHash(forged.ledger[rIdx]);
  const de1 = verifyDoubleEntry(forged, { organId: organ.organId, ledger: organ.ledger, nestReceipt: organ.nestReceipt });
  assert.equal(de1.ok, false);
  assert.ok(de1.errors.some((e) => e.code === "DOUBLE_ENTRY_UNBALANCED"), JSON.stringify(de1.errors));

  // Forge 2: bogus stateHashAfter on the rewind receipt. → STATE_MISMATCH.
  // (In this fixture the rewind receipt is the LAST host receipt, so re-hashing
  // it alone is enough for a self-consistent forged ledger.)
  const forged2 = JSON.parse(JSON.stringify(host));
  const r2 = forged2.ledger.findIndex((r) => r.op.type === ORGAN_REWIND_TYPE);
  forged2.ledger[r2].op.stateHashAfter = "e".repeat(64);
  forged2.ledger[r2].prev = forged2.ledger[r2 - 1].hash;
  forged2.ledger[r2].hash = receiptHash(forged2.ledger[r2]);
  const de2 = verifyDoubleEntry(forged2, { organId: organ.organId, ledger: organ.ledger, nestReceipt: organ.nestReceipt });
  assert.equal(de2.ok, false);
  assert.ok(de2.errors.some((e) => e.code === "DOUBLE_ENTRY_STATE_MISMATCH"), JSON.stringify(de2.errors));

  // Forge 3: evidence list points at a credit that does not exist. → HASH_MISMATCH.
  const forged3 = JSON.parse(JSON.stringify(host));
  const r3 = forged3.ledger.findIndex((r) => r.op.type === ORGAN_REWIND_TYPE);
  forged3.ledger[r3].op.rewound[0].creditSeq = 9999;
  for (let i = r3; i < forged3.ledger.length; i++) {
    if (i > r3) forged3.ledger[i].prev = forged3.ledger[i - 1].hash;
    forged3.ledger[i].hash = receiptHash(forged3.ledger[i]);
  }
  const de3 = verifyDoubleEntry(forged3, { organId: organ.organId, ledger: organ.ledger, nestReceipt: organ.nestReceipt });
  assert.equal(de3.ok, false);
  assert.ok(de3.errors.some((e) => e.code === "DOUBLE_ENTRY_HASH_MISMATCH"), JSON.stringify(de3.errors));
});

// ---------------------------------------------------------------------------
// rewind target bounds — fail-closed
// ---------------------------------------------------------------------------

test("v1 rewind bounds: beyond tip / non-integer / past custody all refuse with named codes", () => {
  const b = advancedBundle(ADVANCE_OPS);
  const tip = b.manifest.receiptRange.end;
  assert.equal(v1ErrorCode(() => rewind(b, tip + 1)), "REWIND_TARGET_INVALID");
  assert.equal(v1ErrorCode(() => rewind(b, 1.5)), "REWIND_TARGET_INVALID");
  assert.equal(v1ErrorCode(() => rewind(b, -1)), "REWIND_PAST_CUSTODY");
  assert.equal(v1ErrorCode(() => stateAt(b, -3)), "REWIND_PAST_CUSTODY");
  assert.equal(v1ErrorCode(() => rewind({ nope: true }, 0)), "REWIND_TARGET_INVALID");

  // checkpoint custody: an extracted range cannot rewind below its carried start
  const shared = makeQuilt("shared-v1");
  quiltApply(shared, { type: "init", cellId: "pre", kind: "value", value: "prefix" });
  const greeter = buildGreeterQuilt();
  for (const r of greeter.ledger) quiltApply(shared, r.op);
  const extracted = snapshot(shared.cells, shared.ledger.slice(1), { name: "greeter-organ", edges: GREETER_EDGES, cellIds: GREETER_CELLS });
  assert.equal(extracted.manifest.genesis.seq, 1);
  // courtroom first: without the pinned checkpoint the extracted bundle refuses outright
  assert.equal(v1ErrorCode(() => rewind(extracted, 1)), "CUSTODY_GAP");
  // with the checkpoint, a target BELOW the carried start is unowned history
  const cp = { seq: 0, hash: shared.ledger[0].hash };
  assert.equal(v1ErrorCode(() => rewind(extracted, 0, { trustedCheckpoint: cp })), "REWIND_PAST_CUSTODY");
  const view = rewind(extracted, 1, { trustedCheckpoint: cp });
  assert.equal(view.provenance.end, 1);
  // transact on a checkpoint-custody bundle: courtroom needs the checkpoint too
  assert.equal(v1ErrorCode(() => transact(extracted, [{ type: "set", cellId: "subject", value: "x" }])), "CUSTODY_GAP");
  const tx = transact(extracted, [{ type: "set", cellId: "subject", value: "x" }], { trustedCheckpoint: cp });
  assert.equal(tx.ok, true);
  assert.equal(boot(tx.bundle, { trustedCheckpoint: cp }).cells.subject.value, "x");
});

// ---------------------------------------------------------------------------
// write-side transactions: all ops or nothing
// ---------------------------------------------------------------------------

test("v1 transact success: staged ops commit as one successor bundle that boots", () => {
  const b = snapshotGreeter();
  const before = canonicalJson(b);
  const tx = transact(b, [
    { type: "set", cellId: "subject", value: "transactional" },
    { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] },
    { type: "init", cellId: "txnote", kind: "value", value: "committed" },
  ]);
  assert.equal(tx.ok, true);
  assert.equal(tx.unchanged, false);
  assert.equal(tx.appliedCount, 3);
  assert.equal(tx.newReceipts.length, 3);
  // receipt chain continues the base tip, contiguous and hash-linked
  assert.equal(tx.newReceipts[0].seq, b.manifest.receiptRange.end + 1);
  assert.equal(tx.newReceipts[0].prev, b.receipts[b.receipts.length - 1].hash);
  // identity carries; lineage pins; range extends; state hash moves
  assert.equal(tx.bundle.manifest.organId, b.manifest.organId);
  assert.equal(tx.bundle.manifest.supersedes, b.manifest.manifestHash);
  assert.equal(tx.bundle.receipts.length, b.receipts.length + 3);
  assert.equal(tx.bundle.manifest.state.cellsSha256, tx.toStateHash);
  assert.notEqual(tx.toStateHash, tx.fromStateHash);
  assert.equal(tx.bundle.manifest.cells.some((c) => c.id === "txnote"), true, "init'd cell joins the manifest");
  // the committed bundle passes the full boot courtroom
  const organ = boot(tx.bundle);
  assert.equal(organ.cells.out.value, "Ahoy, transactional!");
  assert.equal(organ.cells.txnote.value, "committed");
  // input bundle byte-untouched
  assert.equal(canonicalJson(b), before);
  assert.equal(b.receipts.length, GREETER_RECEIPTS);
});

test("v1 transaction atomicity: fail op 2 of 3 → bundle byte-untouched, failure named", () => {
  const b = snapshotGreeter();
  const before = canonicalJson(b);
  const beforeHash = b.manifest.manifestHash;
  const result = transact(b, [
    { type: "set", cellId: "subject", value: "would-be-applied" },
    { type: "set", cellId: "ghost-cell", value: "boom" }, // op 2 of 3: invalid against post-op state
    { type: "set", cellId: "subject", value: "never-reached" },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.phase, "prepare");
  assert.equal(result.failedOp, 1);
  assert.equal(result.code, "OP_APPLY_FAILED");
  assert.equal(result.appliedCount, 1, "op 1 staged but nothing committed");
  assert.deepEqual(result.errors.map((e) => e.opIndex), [1]);
  assert.match(result.detail, /ghost-cell/);
  // THE PROOF: the bundle is byte-identical to before the transaction.
  assert.equal(canonicalJson(b), before);
  assert.equal(b.manifest.manifestHash, beforeHash);
  assert.equal(b.receipts.length, GREETER_RECEIPTS);
  assert.equal(b.state.cells.subject.value, "SuperInstance", "op 1's staged effect never leaked");
});

test("v1 transact failure modes: malformed ops, unknown ops, unserializable state, empty ops", () => {
  const b = snapshotGreeter();
  const r1 = transact(b, [null]);
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "OP_MALFORMED");
  assert.equal(r1.failedOp, 0);

  const r2 = transact(b, [{ type: "explode" }]);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "OP_APPLY_FAILED");
  assert.match(r2.detail, /explode/);

  const r3 = transact(b, [{ type: "init", cellId: "subject", kind: "value", value: "dup" }]);
  assert.equal(r3.ok, false);
  assert.equal(r3.code, "OP_APPLY_FAILED");

  // chained validation: init then set-on-the-new-cell must validate in sequence
  const r4 = transact(b, [
    { type: "init", cellId: "seq-cell", kind: "value", value: 0 },
    { type: "set", cellId: "seq-cell", value: 1 },
  ]);
  assert.equal(r4.ok, true, JSON.stringify(r4.errors));
  assert.equal(r4.bundle.state.cells["seq-cell"].value, 1);

  // empty transaction: a no-op commit returns the identical custody claim
  const r5 = transact(b, []);
  assert.equal(r5.ok, true);
  assert.equal(r5.unchanged, true);
  assert.equal(r5.bundle.manifest.manifestHash, b.manifest.manifestHash);

  // transact refuses non-bundles and forged bases with v0's own law
  const organ = boot(b);
  assert.equal(v1ErrorCode(() => transact(organ, [{ type: "set", cellId: "subject", value: "x" }])), "TRANSACTION_INVALID");
  const forged = JSON.parse(JSON.stringify(b));
  forged.receipts[9].op.value = "Fleet";
  for (let i = 9; i < forged.receipts.length; i++) {
    if (i > 9) forged.receipts[i].prev = forged.receipts[i - 1].hash;
    forged.receipts[i].hash = receiptHash(forged.receipts[i]);
  }
  forged.manifest.manifestHash = computeManifestHash(forged.manifest);
  assert.equal(v1ErrorCode(() => transact(forged, [{ type: "set", cellId: "subject", value: "x" }])), "REPLAY_DIVERGENCE");
});

// ---------------------------------------------------------------------------
// replay divergence THROUGH the v1 operations (the anti-forgery law carries over)
// ---------------------------------------------------------------------------

test("v1 replay divergence: self-consistent forged chains refuse stateAt, rewind AND transact", () => {
  const b = advancedBundle(ADVANCE_OPS);
  // NOTE the honest scope of the law: a forgery whose effect later ops fully
  // overwrite replays to the SAME state and passes (state is DEFINED by replay
  // — the v0 law, unchanged). The forgeries below all survive to the tip.
  const forge = (bundle, at) => {
    const f = JSON.parse(JSON.stringify(bundle));
    if (f.receipts[at].op.type === "init") f.receipts[at].op.value = "FORGED-TEMPLATE";
    else f.receipts[at].op.value = "FORGED";
    for (let i = at; i < f.receipts.length; i++) {
      if (i > at) f.receipts[i].prev = f.receipts[i - 1].hash;
      f.receipts[i].hash = receiptHash(f.receipts[i]);
    }
    f.manifest.manifestHash = computeManifestHash(f.manifest);
    return f;
  };
  // forged INSIDE the provenance window (template init at seq 2 survives to tip) …
  assert.equal(v1ErrorCode(() => rewind(forge(b, 2), 5)), "REPLAY_DIVERGENCE");
  assert.equal(v1ErrorCode(() => stateAt(forge(b, 2), 5)), "REPLAY_DIVERGENCE");
  // … and forged strictly AFTER it (seq 14 is the last subject set): the full
  // carried bundle is verified first, so a rewind cannot become a forgery
  // laundromat for the tail it ignores.
  assert.equal(v1ErrorCode(() => rewind(forge(b, 14), 5)), "REPLAY_DIVERGENCE");
  // the organ form refuses too (in-memory courtroom on the organ's own chain)
  const organ = boot(b);
  const rogue = { ...organ, cells: JSON.parse(JSON.stringify(organ.cells)) };
  rogue.cells.subject.value = "tampered-in-memory";
  assert.equal(v1ErrorCode(() => rewind(rogue, 3)), "REPLAY_DIVERGENCE");
});
