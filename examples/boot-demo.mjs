// boot-demo — snapshot → corrupt → fail-closed → boot in a fresh host quilt
//             → continue appending → re-snapshot → boot again (lane 63-c)
//
// Run: node examples/boot-demo.mjs
// Exit code 0 = every stage proved; a receipt file is written to
// examples/receipts/boot-demo-receipt.json (committed evidence).

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { snapshot, snapshotOrgan, cellsStateHash } from "../src/organ/snapshot.mjs";
import { boot, OrganBootError } from "../src/organ/boot.mjs";
import { verifyDoubleEntry } from "../src/organ/nest.mjs";
import { makeQuilt, quiltApply } from "../src/organ/toyQuilt.mjs";
import { receiptHash } from "../src/organ/manifest.mjs";
import { buildGreeterQuilt, GREETER_FINAL_OUT, GREETER_RECEIPTS } from "./greeter-organ.mjs";

const stages = [];
function stage(name, ok, detail) {
  stages.push({ stage: name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}
const assertEq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

// ---------------------------------------------------------------------------
// Stage 1 — SNAPSHOT: the greeter organ's 12-receipt history becomes a bundle
// ---------------------------------------------------------------------------
const quilt = buildGreeterQuilt();
const bundle1 = snapshot(quilt.cells, quilt.ledger, { name: "greeter-organ", edges: quiltEdges() });

function quiltEdges() {
  // edges live with the fixture (data-flow into the derived `out` cell)
  return [
    { from: "greeting", to: "out" },
    { from: "subject", to: "out" },
    { from: "template", to: "out" },
  ];
}

stage("1.snapshot", true, `organId=${bundle1.manifest.organId} receipts=${bundle1.manifest.receiptRange.count} stateHash=${bundle1.manifest.state.cellsSha256.slice(0, 16)}… manifestHash=${bundle1.manifest.manifestHash.slice(0, 16)}…`);

// ---------------------------------------------------------------------------
// Stage 2 — CORRUPT: flip ONE byte of carried state → boot MUST fail closed
// ---------------------------------------------------------------------------
const corruptState = JSON.parse(JSON.stringify(bundle1));
corruptState.state.cells.out.value = GREETER_FINAL_OUT.replace("!", "?"); // one character
let caught = null;
try {
  boot(corruptState);
} catch (e) {
  if (e instanceof OrganBootError) caught = e;
  else throw e;
}
stage("2.tamper-state", caught?.code === "STATE_HASH_MISMATCH", `flipped '!'→'?' in out; boot refused with ${caught?.code ?? "NO ERROR (BAD)"}`);

// Flip ONE byte inside a receipt payload → hash mismatch → fail closed.
const corruptReceipt = JSON.parse(JSON.stringify(bundle1));
corruptReceipt.receipts[5].op.value = "FL33T"; // tamper seq 5 payload
let caught2 = null;
try {
  boot(corruptReceipt);
} catch (e) {
  if (e instanceof OrganBootError) caught2 = e;
  else throw e;
}
stage("2b.tamper-receipt", caught2?.code === "RECEIPT_HASH_MISMATCH", `tampered seq 5 payload; boot refused with ${caught2?.code ?? "NO ERROR (BAD)"}`);

// ---------------------------------------------------------------------------
// Stage 3 — BOOT: fresh host quilt nests the verified organ
// ---------------------------------------------------------------------------
const host1 = makeQuilt("host-quilt-A");
quiltApply(host1, { type: "init", cellId: "host-vibe", kind: "value", value: "nested" });

const organ1 = boot(bundle1, { host: host1 });
stage("3.boot-nest", organ1.cells.out.value === GREETER_FINAL_OUT && host1.ledger.some((r) => r.op.type === "organ.nest"), `out="${organ1.cells.out.value}"; host ledger seq now ${host1.ledger.length} (init + organ.nest)`);

// ---------------------------------------------------------------------------
// Stage 4 — CONTINUE: append organ ops across the quilt boundary.
// Each op = a DEBIT in the organ ledger + a CREDIT in the host ledger.
// The 4 ops net back to the identical state (subject restored), so the
// re-snapshot below must carry the SAME state hash on a LONGER chain —
// content addressing in action.
// ---------------------------------------------------------------------------
organ1.append({ type: "set", cellId: "subject", value: "organ" });
organ1.append({ type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] });
organ1.append({ type: "set", cellId: "subject", value: "SuperInstance" });
organ1.append({ type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] });

const de = verifyDoubleEntry(host1, organ1);
stage("4.continue-double-entry", de.ok && de.creditsChecked === 4 && organ1.cells.out.value === GREETER_FINAL_OUT, `4 debits / ${de.creditsChecked} credits pair 1:1, state hashes attested; out="${organ1.cells.out.value}"`);

// ---------------------------------------------------------------------------
// Stage 5 — RE-SNAPSHOT → BOOT AGAIN: portability across a second host
// ---------------------------------------------------------------------------
const bundle2 = snapshotOrgan(organ1);
stage("5.re-snapshot", bundle2.receipts.length === GREETER_RECEIPTS + 4 && bundle2.manifest.supersedes === bundle1.manifest.manifestHash, `receipts ${bundle2.receipts.length} (${GREETER_RECEIPTS}+4), supersedes=${bundle2.manifest.supersedes.slice(0, 16)}…, organId stable=${bundle2.manifest.organId === bundle1.manifest.organId}`);

const host2 = makeQuilt("host-quilt-B");
quiltApply(host2, { type: "init", cellId: "host-vibe", kind: "value", value: "second-home" });
const organ2 = boot(bundle2, { host: host2 });

const hashBefore = cellsStateHash(organ1.cells);
const hashAfter = cellsStateHash(organ2.cells);
stage("5b.replay-determinism", hashBefore === hashAfter && hashAfter === bundle1.manifest.state.cellsSha256, `state hash BEFORE nesting round-trip == AFTER == snapshot claim: ${hashAfter}`);

const de2 = verifyDoubleEntry(host2, organ2);
stage("5c.second-host-double-entry", de2.ok && de2.creditsChecked === 0, `re-nested in ${host2.name}; 0 new credits until it appends (nest marker pins organSeq ${host2.ledger.find((r) => r.op.type === "organ.nest").op.organSeq})`);

// FORGE a host CREDIT after the fact (attacker re-hashes + re-chains the whole
// host ledger so the host chain itself looks intact) → double-entry audit must
// still catch the lie, because stateHashAfter no longer matches what the organ
// ledger replays to at that seq.
const tamperedHost = JSON.parse(JSON.stringify(host1));
const creditIdx = tamperedHost.ledger.findIndex((r) => r.op.type === "organ.credit");
tamperedHost.ledger[creditIdx].op.stateHashAfter = "f".repeat(64);
for (let i = creditIdx; i < tamperedHost.ledger.length; i++) {
  if (i > creditIdx) tamperedHost.ledger[i].prev = tamperedHost.ledger[i - 1].hash;
  tamperedHost.ledger[i].hash = receiptHash(tamperedHost.ledger[i]);
}
const organ1Frozen = { organId: organ1.organId, ledger: organ1.ledger, nestReceipt: organ1.nestReceipt };
const de3 = verifyDoubleEntry(tamperedHost, organ1Frozen);
stage("5d.credit-forgery-fail-closed", !de3.ok && de3.errors.some((e) => e.code === "DOUBLE_ENTRY_STATE_MISMATCH"), `self-consistent forged ledger caught: ${de3.errors[0]?.code}`);

// ---------------------------------------------------------------------------
// Receipt file — committed evidence
// ---------------------------------------------------------------------------
mkdirSync(join(dirname(fileURLToPath(import.meta.url)), "receipts"), { recursive: true });
const receiptPath = join(dirname(fileURLToPath(import.meta.url)), "receipts", "boot-demo-receipt.json");
const receipt = {
  schema: "quilt-jev-toolkit/boot-demo-receipt/v0",
  lane: "63-c",
  writtenAt: new Date().toISOString(),
  organ: { organId: bundle1.manifest.organId, name: "greeter-organ" },
  manifests: {
    snapshot1: { manifestHash: bundle1.manifest.manifestHash, stateHash: bundle1.manifest.state.cellsSha256, receipts: bundle1.manifest.receiptRange.count },
    snapshot2: { manifestHash: bundle2.manifest.manifestHash, stateHash: bundle2.manifest.state.cellsSha256, receipts: bundle2.manifest.receiptRange.count, supersedes: bundle2.manifest.supersedes },
  },
  replayDeterminism: { hashBefore: hashBefore, hashAfter: hashAfter, equal: hashBefore === hashAfter },
  failClosed: [
    { case: "state byte flip", code: caught?.code },
    { case: "receipt payload byte flip", code: caught2?.code },
    { case: "host credit attestation forgery", code: de3.errors?.[0]?.code },
  ],
  hostLedgers: { host1: host1.ledger.length, host2: host2.ledger.length },
  stages,
};
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
console.log(`\nreceipt written: ${receiptPath}`);
console.log(`organ says: "${organ2.cells.out.value}" (organId ${organ2.organId})`);
if (process.exitCode) {
  console.error("BOOT DEMO FAILED — see [FAIL] stage above");
}
