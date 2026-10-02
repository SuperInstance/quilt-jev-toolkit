// chrono-interop.test.mjs — wave-68 lane 68-a acceptance suite
//
// The chrono-op adapter (src/organ/chronoOps.js) turns a sealed quilt-chrono
// sheet (ledger + chain sidecar + seal) into a booted organ. Law under test:
// docs/REVERSE-ACTUALIZED-SPEC.md §9 — every mapping decision has a named
// reason, and every refusal has a named code.
//
// Two layers:
//   1. tests/fixtures/chrono-fixture.json — a REAL chrono sheet, sealed by
//      quilt-chrono's OWN seal() at generation time (provenance in the file).
//      Everything here runs without the sibling repo present: the bytes are
//      the contract.
//   2. the LIVE test at the bottom imports ../quilt-chrono directly when it
//      exists (skip-if-absent — the 67-a interop pattern, this time from the
//      organ side) and proves build → seal → bootChrono end to end.
//
// The suite-local mintSeal() reimplements the chrono seal contract from the
// SPEC alone (manifest shape + HMAC over {hash, manifestHash, seq}). It exists
// so crafted chains can carry VALID seals — with HMAC the keyholder IS the
// minter, the honest scope §8.3 — and doubles as proof the format is
// spec-complete (any drift fails loudly against verifySignedCheckpoint).

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  GENESIS,
  canonicalJson,
  computeManifestHash,
  sha256Json,
  verifyChain,
} from "../src/organ/manifest.mjs";
import { applyOp, makeQuilt } from "../src/organ/toyQuilt.mjs";
import { boot, OrganBootError, verifySignedCheckpoint } from "../src/organ/boot.mjs";
import { nestInto, verifyDoubleEntry } from "../src/organ/nest.mjs";
import { stateAt, rewind } from "../src/organ/rewind.mjs";
import { snapshotOrgan } from "../src/organ/snapshot.mjs";
import {
  bootChrono,
  mapChronoChain,
  CHRONO_READ_TYPE,
} from "../src/organ/chronoOps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, "fixtures", "chrono-fixture.json"), "utf8"));
const KEY = fixture.key; // test-only fixture key, not a credential

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof OrganBootError) return e.code;
    throw e;
  }
  return null; // survived — caller asserts otherwise
};

// ---------------------------------------------------------------------------
// suite-local seal minting (spec-derived; see file header)
// ---------------------------------------------------------------------------

function mkEntry(i, fields) {
  return {
    seq: i,
    ts_utc: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    op: "write",
    cell: "c",
    value: null,
    by: "test",
    cause: "set",
    pushed: false,
    flow_id: null,
    edge: null,
    corrects: null,
    ...fields,
  };
}

/** Chrono's chain law: one organ receipt per entry, op = entry verbatim,
 *  hash = sha256(canonical({seq, op, prev})) — the ORGAN receipt formula
 *  (chrono seal.js entryLink). NOTE: this is deliberately NOT organ
 *  makeReceipt — makeReceipt additionally demands op.type, which chrono
 *  entries don't carry (they name their verb in op.op). The sidecar therefore
 *  VERIFIES under organ verifyChain but cannot be MINTED by makeReceipt —
 *  an honest asymmetry this suite documents (spec §9, bridge law). */
function chainOf(entries) {
  const links = [];
  let prev = GENESIS;
  entries.forEach((e, i) => {
    const hash = sha256Json({ seq: i, op: e, prev });
    links.push({ seq: i, op: e, prev, hash });
    prev = hash;
  });
  return links;
}

/** Chrono's state law: the fold of writes ≤ boundary (cellsAt). */
function foldWrites(entries, upto) {
  const cells = {};
  for (let i = 0; i <= upto; i++) {
    const e = entries[i];
    if (e && e.op === "write" && typeof e.cell === "string") {
      cells[e.cell] = { kind: "value", value: e.value === undefined ? null : e.value };
    }
  }
  return cells;
}

/** Mint a valid chrono-style seal over arbitrary entries (spec §8.1 + §9). */
function mintSeal(entries, { key = KEY, name = "crafted", boundary = entries.length - 1, manifestHash = null } = {}) {
  const links = chainOf(entries);
  const cells = foldWrites(entries, boundary);
  const cellIds = Object.keys(cells).sort();
  const manifest = {
    schema: "quilt.organ.manifest",
    schemaVersion: 1,
    organId: `${name}@${sha256Json({ name, material: { cells: sha256Json(cells), tip: links[boundary].hash } }).slice(0, 16)}`,
    name,
    cells: cellIds.map((id) => ({ id, kind: "value", stateHash: sha256Json({ kind: "value", value: cells[id].value }) })),
    edges: [],
    receiptRange: { start: 0, end: boundary, count: boundary + 1 },
    genesis: { seq: 0, prevHash: GENESIS },
    state: { cellsSha256: sha256Json(cells) },
    supersedes: null,
  };
  const mh = manifestHash ?? computeManifestHash(manifest);
  manifest.manifestHash = mh;
  const cp = {
    schema: "quilt.organ.checkpoint",
    schemaVersion: 1,
    alg: "HMAC-SHA256",
    seq: boundary,
    hash: links[boundary].hash,
    manifestHash: mh,
  };
  cp.sig = createHmac("sha256", Buffer.from(key, "utf8"))
    .update(canonicalJson({ hash: cp.hash, manifestHash: cp.manifestHash, seq: cp.seq }), "utf8")
    .digest("hex");
  cp.manifest = JSON.parse(canonicalJson(manifest));
  return { checkpoint: cp, links };
}

const reSign = (cp, key = KEY) => {
  const copy = { ...cp };
  copy.sig = createHmac("sha256", Buffer.from(key, "utf8"))
    .update(canonicalJson({ hash: copy.hash, manifestHash: copy.manifestHash, seq: copy.seq }), "utf8")
    .digest("hex");
  return copy;
};

// ---------------------------------------------------------------------------
// 1. the fixture IS a real chrono seal — verified by the organ's own verifiers
// ---------------------------------------------------------------------------

test("fixture integrity: the committed seal verifies under organ verifySignedCheckpoint and the sidecar verifies as an organ receipt chain", () => {
  assert.equal(fixture.links.length, 7);
  assert.equal(fixture.checkpoint.seq, 6);
  const sig = verifySignedCheckpoint(fixture.checkpoint, KEY);
  assert.deepEqual(sig, { ok: true });
  const cv = verifyChain(fixture.links, { expectedStart: 0, expectedPrev: GENESIS });
  assert.equal(cv.ok, true);
  assert.equal(cv.tipHash, fixture.chainTip);
  assert.equal(fixture.checkpoint.hash, fixture.chainTip);
});

// ---------------------------------------------------------------------------
// 2. the round-trip: sealed chrono sheet → booted organ
// ---------------------------------------------------------------------------

test("bootChrono round-trip: the sealed sheet boots as an organ; state == the independent write-fold oracle; identity carried from the seal", () => {
  const organ = bootChrono({ links: fixture.links, checkpoint: fixture.checkpoint }, { key: KEY });
  // state equality — against the generator's independent fold, not against
  // anything the adapter computed
  assert.deepEqual(organ.cells, fixture.expectedCellsAtTip);
  assert.deepEqual(organ.cells, {
    "sensor.temp": { kind: "value", value: 22.1 },
    "sink.display": { kind: "value", value: 22.4 },
  });
  // identity is CARRIED (organ law), not re-minted
  assert.equal(organ.manifest.organId, fixture.organId);
  assert.equal(organ.manifest.manifestHash, fixture.manifestHash);
  // R8: with the seal at the tip, the SIGNED manifest is the organ manifest
  assert.deepEqual(organ.manifest, fixture.checkpoint.manifest);
  // provenance
  assert.equal(organ.custody.kind, "chrono-seal");
  assert.deepEqual(organ.custody.signedAt, {
    seq: 6, hash: fixture.chainTip, manifestHash: fixture.manifestHash,
  });
  assert.deepEqual(organ.custody.sealedRange, { start: 0, end: 6 });
  assert.deepEqual(organ.custody.verifiedRange, { start: 0, end: 6 });
  assert.equal(organ.custody.chainTip, fixture.chainTip);
});

test("the mapped ledger is self-describing (R5) and wall-clock-free (R6): every receipt names its sealed source link; no ts_utc crossed", () => {
  const organ = bootChrono({ links: fixture.links, checkpoint: fixture.checkpoint }, { key: KEY });
  organ.ledger.forEach((r, i) => {
    assert.deepEqual(r.op.chrono, { seq: i, hash: fixture.links[i].hash });
    assert.equal(JSON.stringify(r.op).includes("ts_utc"), false, `seq ${i}: wall-clock crossed the boundary`);
    assert.equal(r.seq, i);
  });
  // the organ chain is its own valid organ receipt chain
  const cv = verifyChain(organ.ledger, { expectedStart: 0, expectedPrev: GENESIS });
  assert.equal(cv.ok, true);
});

test("§9 mapping decisions land exactly: read → no-op witness (R1), unborn write → init kind value (R2), born write → set (R3), push → the (witness, set) pair (R4)", () => {
  const organ = bootChrono({ links: fixture.links, checkpoint: fixture.checkpoint }, { key: KEY });
  const ops = organ.ledger.map((r) => r.op);

  // R2 — seq 0: birth by init-write
  assert.equal(ops[0].type, "init");
  assert.equal(ops[0].cellId, "sensor.temp");
  assert.equal(ops[0].kind, "value");
  assert.equal(ops[0].value, 21.5);

  // R1 — seq 1: a pull-read is a witness receipt, no transition
  assert.equal(ops[1].type, CHRONO_READ_TYPE);
  assert.equal(ops[1].cellId, "sensor.temp");
  assert.equal(ops[1].witness, 21.5);
  assert.equal(ops[1].by, "agent:operator");
  assert.equal(ops[1].cause, "pull");
  // the no-op is real: applyOp (the toy evaluator the full boot uses) leaves
  // cells untouched on a witness receipt
  const probe = { "sensor.temp": { kind: "value", value: "UNTOUCHED" } };
  assert.equal(applyOp(probe, ops[1]), undefined);
  assert.equal(probe["sensor.temp"].value, "UNTOUCHED");

  // R3 — seq 2: born cell, set
  assert.equal(ops[2].type, "set");
  assert.equal(ops[2].value, 22.1);

  // R4 — seqs 3+4: the push pair arrives as two entries and lands as
  // (witness of the source read, birth-of-sink). The sink is UNBORN before
  // its first delivery, so R2 applies inside the pair: the sink write is an
  // init (kind value) — the push BIRTHS its sink.
  assert.equal(ops[3].type, CHRONO_READ_TYPE);
  assert.equal(ops[3].cellId, "sensor.temp");
  assert.equal(ops[3].witness, 22.1);
  assert.equal(ops[3].by, "push:sink.display");
  assert.equal(ops[4].type, "init");
  assert.equal(ops[4].cellId, "sink.display");
  assert.equal(ops[4].kind, "value");
  assert.equal(ops[4].value, 22.1);
  assert.equal(fixture.links[3].op.pushed, true);
  assert.equal(fixture.links[4].op.pushed, true);

  // R1 — seq 5: the honest null read (a pull of a missing cell) witnesses null
  assert.equal(ops[5].type, CHRONO_READ_TYPE);
  assert.equal(ops[5].witness, null);
  assert.equal(ops[5].cellId, "ghost.cell");

  // R3 — seq 6
  assert.equal(ops[6].type, "set");
  assert.equal(ops[6].value, 22.4);
});

test("mapChronoChain is deterministic: same links → byte-identical receipts", () => {
  const a = mapChronoChain(fixture.links);
  const b = mapChronoChain(fixture.links);
  assert.equal(canonicalJson(a.receipts), canonicalJson(b.receipts));
});

// ---------------------------------------------------------------------------
// 3. fail-closed: tamper, forgery, truncation
// ---------------------------------------------------------------------------

test("tamper at every offset: flipping any byte of any link refuses with the named seq (RECEIPT_HASH_MISMATCH)", () => {
  for (let k = 0; k < fixture.links.length; k++) {
    const links = structuredClone(fixture.links);
    // flip the payload of link k (its op is the chrono entry verbatim)
    if (typeof links[k].op.value === "number") links[k].op.value += 0.5;
    else links[k].op.by = `tampered-${k}`;
    const code = codeOf(() => bootChrono({ links, checkpoint: fixture.checkpoint }, { key: KEY }));
    assert.equal(code, "RECEIPT_HASH_MISMATCH", `offset ${k}`);
    try {
      bootChrono({ links, checkpoint: fixture.checkpoint }, { key: KEY });
    } catch (e) {
      assert.ok(e.detail.includes(`seq ${k}`), `error must name the tampered seq ${k}`);
    }
  }
});

test("forged seal refused: flipped sig, tampered signed field, wrong key, missing key", () => {
  const base = () => ({ links: structuredClone(fixture.links), checkpoint: structuredClone(fixture.checkpoint) });

  const forged = base();
  forged.checkpoint.sig = forged.checkpoint.sig.replace(/^./, forged.checkpoint.sig[0] === "0" ? "1" : "0");
  assert.equal(codeOf(() => bootChrono(forged, { key: KEY })), "CHECKPOINT_SIGNATURE_INVALID");

  const tampered = base();
  tampered.checkpoint.hash = tampered.checkpoint.hash.replace(/^./, "f"); // a SIGNED field
  assert.equal(codeOf(() => bootChrono(tampered, { key: KEY })), "CHECKPOINT_SIGNATURE_INVALID");

  assert.equal(codeOf(() => bootChrono(base(), { key: "a-different-key" })), "CHECKPOINT_SIGNATURE_INVALID");
  assert.equal(codeOf(() => bootChrono(base(), {})), "CHECKPOINT_SIGNATURE_REQUIRED");
  assert.equal(codeOf(() => bootChrono(base(), { key: "" })), "CHECKPOINT_SIGNATURE_REQUIRED");
});

test("truncated bundle refused: the sidecar ending below its own custody boundary is CHECKPOINT_SEQ_BEYOND_RECEIPTS; a different chain at the boundary is CUSTODY_CHECKPOINT_MISMATCH", () => {
  // truncate one link below the seal
  const truncated = structuredClone(fixture.links).slice(0, 6);
  assert.equal(
    codeOf(() => bootChrono({ links: truncated, checkpoint: fixture.checkpoint }, { key: KEY })),
    "CHECKPOINT_SEQ_BEYOND_RECEIPTS",
  );
  // an honestly-built but DIFFERENT chain at the boundary: the anchor manifest
  // stays genuine (it re-hashes to its signed manifestHash), the chain is
  // valid — only the boundary pin can catch the swap
  const other = mintSeal([mkEntry(0, { cell: "x", value: 1 }), mkEntry(1, { cell: "x", value: 2 })], { name: "other" });
  const foreign = structuredClone(fixture.checkpoint);
  foreign.hash = other.links[other.links.length - 1].hash; // tip of another chain
  const reSigned = reSign(foreign); // the keyholder can re-sign — the ANCHOR must still pin the carried chain
  assert.equal(verifySignedCheckpoint(reSigned, KEY).ok, true);
  assert.equal(
    codeOf(() => bootChrono({ links: structuredClone(fixture.links), checkpoint: reSigned }, { key: KEY })),
    "CUSTODY_CHECKPOINT_MISMATCH",
  );
});

test("swapped anchor manifest refused: a re-signed checkpoint whose manifestHash anchors nothing is CHECKPOINT_ANCHOR_MISMATCH", () => {
  const cp = structuredClone(fixture.checkpoint);
  cp.manifestHash = sha256Json({ swapped: true }).repeat(1); // hex64, but anchors no manifest
  const reSigned = reSign(cp); // signature-valid over the bogus anchor
  assert.equal(verifySignedCheckpoint(reSigned, KEY).ok, true);
  assert.equal(
    codeOf(() => bootChrono({ links: structuredClone(fixture.links), checkpoint: reSigned }, { key: KEY })),
    "CHECKPOINT_ANCHOR_MISMATCH",
  );
});

test("internally-consistent forgery with a STALE signed manifest: re-hashed chain + re-signed tip + old manifest → REPLAY_DIVERGENCE", () => {
  // the minter signed manifest A (over entries A) but anchors the tip of a
  // DIFFERENT chain B — every signature and hash is self-consistent, and only
  // the replay-vs-manifest assertion can catch the divergence (the v0 law,
  // now guarding the translation).
  const entriesA = [mkEntry(0, { cell: "x", value: 1 }), mkEntry(1, { cell: "x", value: 2 }), mkEntry(2, { cell: "y", value: 10 })];
  const entriesB = [mkEntry(0, { cell: "x", value: 1 }), mkEntry(1, { cell: "x", value: 999 }), mkEntry(2, { cell: "y", value: 10 })];
  const sealA = mintSeal(entriesA);
  const linksB = chainOf(entriesB); // valid chain, different tip, different state
  const forgedCp = structuredClone(sealA.checkpoint);
  forgedCp.hash = linksB[linksB.length - 1].hash; // anchor B's tip …
  const reSigned = reSign(forgedCp); // … under a fresh signature
  assert.equal(verifySignedCheckpoint(reSigned, KEY).ok, true);
  assert.equal(
    codeOf(() => bootChrono({ links: linksB, checkpoint: reSigned }, { key: KEY })),
    "REPLAY_DIVERGENCE",
  );
});

// ---------------------------------------------------------------------------
// 4. semantic refusals — the mapping's own law
// ---------------------------------------------------------------------------

test("semantically-unmappable op refused: an entry that is neither read nor write → CHRONO_OP_UNMAPPABLE (never coerced)", () => {
  const entries = [
    mkEntry(0, { cell: "x", value: 1 }),
    mkEntry(1, { cell: "x", value: 2 }),
    mkEntry(2, { op: "flush", cell: "x", value: 3 }), // not a chrono verb
    mkEntry(3, { cell: "x", value: 4 }),
  ];
  const { checkpoint, links } = mintSeal(entries);
  assert.equal(codeOf(() => bootChrono({ links, checkpoint }, { key: KEY })), "CHRONO_OP_UNMAPPABLE");
  // and the bridge alone refuses identically (no seal needed to say no)
  assert.equal(codeOf(() => mapChronoChain(links)), "CHRONO_OP_UNMAPPABLE");
});

test("the causal fabric crosses the boundary: a flow-tagged write with no read of that flow → CHRONO_FLOW_UNPAIRED; pairing it repairs the chain", () => {
  const unpaired = [
    mkEntry(0, { cell: "src", value: 5 }),
    mkEntry(1, { cell: "dst", value: 5, pushed: true, flow_id: "flow-0-0", edge: "src->dst" }), // no read of flow-0-0
  ];
  const sealedBad = mintSeal(unpaired);
  assert.equal(codeOf(() => bootChrono({ links: sealedBad.links, checkpoint: sealedBad.checkpoint }, { key: KEY })), "CHRONO_FLOW_UNPAIRED");

  const paired = [
    mkEntry(0, { cell: "src", value: 5 }),
    mkEntry(1, { op: "read", cell: "src", value: 5, by: "push:dst", pushed: true, flow_id: "flow-0-0", edge: "src->dst" }),
    mkEntry(2, { cell: "dst", value: 5, pushed: true, flow_id: "flow-0-0", edge: "src->dst" }),
  ];
  const sealedGood = mintSeal(paired);
  const organ = bootChrono({ links: sealedGood.links, checkpoint: sealedGood.checkpoint }, { key: KEY });
  assert.deepEqual(organ.cells, { src: { kind: "value", value: 5 }, dst: { kind: "value", value: 5 } });
});

// ---------------------------------------------------------------------------
// 5. post-seal appends, time travel, nesting — the organ is ALIVE
// ---------------------------------------------------------------------------

test("post-seal appends boot honestly: custody records signed ⊂ verified, lineage pins the sealed manifest, tail tamper still refused", () => {
  // extend the sidecar the honest way: two more chain-linked entries, no re-seal
  const extra = [
    mkEntry(7, { cell: "sink.display", value: 23, by: "agent:operator", cause: "set" }),
    mkEntry(8, { op: "read", cell: "sink.display", value: 23, by: "agent:operator", cause: "pull" }),
  ];
  const links = structuredClone(fixture.links);
  let prev = fixture.chainTip;
  extra.forEach((e, i) => {
    const hash = sha256Json({ seq: 7 + i, op: e, prev }); // chrono's entryLink formula
    links.push({ seq: 7 + i, op: e, prev, hash });
    prev = hash;
  });

  const organ = bootChrono({ links, checkpoint: fixture.checkpoint }, { key: KEY });
  assert.equal(organ.cells["sink.display"].value, 23); // the tail landed
  assert.deepEqual(organ.custody.sealedRange, { start: 0, end: 6 });
  assert.deepEqual(organ.custody.verifiedRange, { start: 0, end: 8 });
  assert.equal(organ.manifest.organId, fixture.organId); // identity carried
  assert.equal(organ.manifest.supersedes, fixture.manifestHash); // honest lineage to the SIGNED manifest
  assert.equal(organ.manifest.manifestHash !== fixture.manifestHash, true); // a new claim, honestly lineage-pinned

  // the tail is hash-chain custody: flip a tail byte → named refusal
  const tampered = structuredClone(links);
  tampered[7].op.value = 99;
  assert.equal(codeOf(() => bootChrono({ links: tampered, checkpoint: fixture.checkpoint }, { key: KEY })), "RECEIPT_HASH_MISMATCH");
});

test("time travel on the chrono-born organ: stateAt/rewind equal the independent fold at every seq; the organ continues from the rewound tip", () => {
  const organ = bootChrono({ links: fixture.links, checkpoint: fixture.checkpoint }, { key: KEY });

  // independent oracle: the write-fold at seq t, computed from the raw entries
  const foldAt = (t) => {
    const cells = {};
    for (let i = 0; i <= t; i++) {
      const e = fixture.links[i].op;
      if (e.op === "write") cells[e.cell] = { kind: "value", value: e.value };
    }
    return cells;
  };

  for (const t of [0, 2, 4, 6]) {
    const v = stateAt(organ, t);
    assert.deepEqual(v.state.cells, foldAt(t), `stateAt(${t})`);
  }

  // rewind is destructive and the organ keeps living from the rewound tip
  const rw = rewind(organ, 2);
  assert.deepEqual(rw.state.cells, foldAt(2));
  assert.deepEqual(organ.cells, foldAt(2));
  const { debit } = organ.append({ type: "set", cellId: "sensor.temp", value: 30 });
  assert.equal(debit.seq, 3);
  assert.equal(debit.prev, organ.ledger[2].hash); // the SAME hash chain, custody unbroken
  const cv = verifyChain(organ.ledger, { expectedStart: 0, expectedPrev: GENESIS });
  assert.equal(cv.ok, true);
  // full custody: rewinding all the way back is legal too (nothing is unowned
  // history); seq 0 is the sheet's first write — the birth of sensor.temp
  rewind(organ, 0);
  assert.deepEqual(organ.cells, foldAt(0));
});

test("a chrono-born organ re-snapshots, nests into a toy quilt, and double-entry verifies — any quilt.organ host can adopt it", () => {
  const organ = bootChrono({ links: fixture.links, checkpoint: fixture.checkpoint }, { key: KEY });

  // re-snapshot: the translated bundle is FULL custody from GENESIS (the
  // adapter carried every receipt), so it boots standalone with no key
  const bundle2 = snapshotOrgan(organ);
  assert.equal(bundle2.seed, undefined);
  const organ2 = boot(bundle2);
  assert.deepEqual(organ2.cells, organ.cells);

  // nesting: the chrono-born organ wakes inside a toy quilt
  const host = makeQuilt("host");
  const organ3 = boot(bundle2, { host });
  organ3.append({ type: "set", cellId: "sensor.temp", value: 25 });
  const audit = verifyDoubleEntry(host, organ3);
  assert.equal(audit.ok, true, JSON.stringify(audit.errors ?? audit));
});

// ---------------------------------------------------------------------------
// 6. LIVE round-trip against quilt-chrono's own exports (skip-if-absent —
//    the 67-a interop pattern, run from the organ side this time)
// ---------------------------------------------------------------------------

const chronoDir = path.resolve(here, "..", "..", "quilt-chrono");
const chronoLive = existsSync(path.join(chronoDir, "src", "seal.js"));

test("LIVE interop: build a chrono sheet with quilt-chrono's Ledger, seal it with chrono's seal(), boot it through bootChrono, and agree with chrono's own verifyCustody", { skip: chronoLive ? false : "quilt-chrono sibling not present — the committed fixture carries the proof" }, async () => {
  const { Ledger, Clock } = await import(pathToFileURL(path.join(chronoDir, "src", "ledger.js")).href);
  const { seal, verifyCustody } = await import(pathToFileURL(path.join(chronoDir, "src", "seal.js")).href);

  // the same demo sheet the fixture generator runs — this time LIVE
  const clock = new Clock({ startMs: Date.parse("2026-01-01T00:00:00.000Z"), stepMs: 1000 });
  const ledger = new Ledger({ name: "live-sheet", clock });
  ledger.append({ op: "write", cell: "sensor.temp", value: 21.5, by: "engine:init", cause: "init", pushed: false, flow_id: null });
  ledger.append({ op: "read", cell: "sensor.temp", value: 21.5, by: "agent:operator", cause: "pull", pushed: false, flow_id: null });
  ledger.append({ op: "write", cell: "sensor.temp", value: 22.1, by: "agent:operator", cause: "set", pushed: false, flow_id: null });
  ledger.recordFlow({ from: "sensor.temp", to: "sink.display", value: 22.1, by: "engine:wire", cause: "push", edge: "sensor.temp->sink.display" });
  ledger.append({ op: "read", cell: "ghost.cell", value: null, by: "agent:operator", cause: "pull", pushed: false, flow_id: null });
  ledger.append({ op: "write", cell: "sink.display", value: 22.4, by: "agent:operator", cause: "set", pushed: false, flow_id: null });
  const sealed = seal(ledger, { key: KEY, name: "live-sheet" });

  // chrono's own courtroom accepts the seal (sanity: we sealed what we think)
  const custody = verifyCustody(sealed.checkpoint, KEY, { links: sealed.links });
  assert.equal(custody.ok, true);

  // the organ boots the same bytes
  const organ = bootChrono({ links: sealed.links, checkpoint: sealed.checkpoint }, { key: KEY });
  const fold = {};
  for (const e of ledger.entries) if (e.op === "write") fold[e.cell] = { kind: "value", value: e.value };
  assert.deepEqual(organ.cells, fold);
  assert.deepEqual(organ.cells, custody.cells); // organ boot == chrono's own anchored replay
  assert.equal(organ.manifest.organId, sealed.checkpoint.manifest.organId);
  assert.equal(organ.custody.kind, "chrono-seal");

  // and a tampered live sidecar still refuses by name
  const tampered = structuredClone(sealed.links);
  tampered[2].op.value = 0;
  assert.equal(
    codeOf(() => bootChrono({ links: tampered, checkpoint: sealed.checkpoint }, { key: KEY })),
    "RECEIPT_HASH_MISMATCH",
  );
});
