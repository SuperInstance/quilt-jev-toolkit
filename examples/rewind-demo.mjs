// rewind-demo — ORGAN BOOT v1 end-to-end (lane 64-a)
//
// stateAt → transact (success + atomic failure) → rewind to genesis →
// rewind past a nest boundary with the compensating host receipt →
// fail-closed rewind audit. Run: node examples/rewind-demo.mjs
// Exit 0 = every stage proved; receipt written to
// examples/receipts/rewind-v1-demo-receipt.json (committed evidence).

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { canonicalJson, receiptHash } from "../src/organ/manifest.mjs";
import { makeQuilt, quiltApply, applyOp } from "../src/organ/toyQuilt.mjs";
import { snapshot, snapshotOrgan, cellsStateHash } from "../src/organ/snapshot.mjs";
import { boot } from "../src/organ/boot.mjs";
import { verifyDoubleEntry } from "../src/organ/nest.mjs";
import { stateAt, rewind, transact, ORGAN_REWIND_TYPE } from "../src/organ/rewind.mjs";
import { buildGreeterQuilt, GREETER_FINAL_OUT, GREETER_RECEIPTS, GREETER_EDGES } from "./greeter-organ.mjs";

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
const short = (h) => `${h.slice(0, 16)}…`;

// ---------------------------------------------------------------------------
// Stage 1 — WRITE TRANSACTION: advance the greeter by 4 ops in ONE atomic
// transact() → successor bundle boots, lineage pinned, input untouched.
// ---------------------------------------------------------------------------
const greeterQuilt = buildGreeterQuilt();
const base = snapshot(greeterQuilt.cells, greeterQuilt.ledger, { name: "greeter-organ", edges: GREETER_EDGES });
const baseBytes = canonicalJson(base);

const tx = transact(base, [
  { type: "set", cellId: "greeting", value: "Salutations" },
  { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] },
  { type: "set", cellId: "subject", value: "v1" },
  { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] },
]);
assertEq(tx.ok, true, "transact ok");
const organ1 = boot(tx.bundle); // the committed bundle passes the full courtroom
assertEq(organ1.cells.out.value, "Salutations, v1!", "transacted state");
stage(
  "1.transact-commit",
  tx.bundle.manifest.supersedes === base.manifest.manifestHash &&
    tx.bundle.receipts.length === GREETER_RECEIPTS + 4 &&
    canonicalJson(base) === baseBytes,
  `4 ops committed once: receipts ${base.receipts.length}→${tx.bundle.receipts.length}, supersedes=${short(tx.bundle.manifest.supersedes)}, out="${organ1.cells.out.value}"`
);

// ---------------------------------------------------------------------------
// Stage 2 — TRANSACTION ATOMICITY: op 2 of 3 fails → bundle byte-untouched.
// ---------------------------------------------------------------------------
const failed = transact(base, [
  { type: "set", cellId: "subject", value: "would-be-applied" },
  { type: "set", cellId: "ghost-cell", value: "boom" },
  { type: "set", cellId: "subject", value: "never-reached" },
]);
stage(
  "2.transact-atomicity",
  failed.ok === false &&
    failed.failedOp === 1 &&
    failed.code === "OP_APPLY_FAILED" &&
    canonicalJson(base) === baseBytes,
  `op 2 of 3 refused [${failed.code}] at failedOp=${failed.failedOp}; base bundle byte-identical (all-ops-or-nothing)`
);

// ---------------------------------------------------------------------------
// Stage 3 — TIME-TRAVEL QUERY: stateAt(seq) == independent prefix replay,
// deterministic across independent builds, pure on the queried bundle.
// ---------------------------------------------------------------------------
const tipSeq = tx.bundle.manifest.receiptRange.end;
const reference = {};
for (let i = 0; i <= 5; i++) applyOp(reference, tx.bundle.receipts[i].op);
const at5 = stateAt(tx.bundle, 5);
const ADVANCE = [
  { type: "set", cellId: "greeting", value: "Salutations" },
  { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] },
  { type: "set", cellId: "subject", value: "v1" },
  { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] },
];
const determinismBuild = transact(
  snapshot(buildGreeterQuilt().cells, buildGreeterQuilt().ledger, { name: "greeter-organ", edges: GREETER_EDGES }),
  ADVANCE
);
stage(
  "3.stateAt-determinism",
  at5.stateHash === cellsStateHash(reference) &&
    at5.stateHash === stateAt(determinismBuild.bundle, 5).stateHash &&
    tx.bundle.receipts.length === GREETER_RECEIPTS + 4,
  `stateAt(5)=${short(at5.stateHash)} == independent replay == second build; bundle untouched`
);

// ---------------------------------------------------------------------------
// Stage 4 — REWIND TO GENESIS: rewind(bundle, 0) == the state after receipt 0,
// byte-identical to an independent replay; provenance range reported.
// ---------------------------------------------------------------------------
const genesisRef = {};
applyOp(genesisRef, tx.bundle.receipts[0].op);
const gen = rewind(tx.bundle, 0);
stage(
  "4.rewind-genesis",
  gen.provenance.count === 1 &&
    gen.stateHash === cellsStateHash(genesisRef) &&
    canonicalJson(gen.state) === canonicalJson({ cells: genesisRef }),
  `rewind to seq 0: provenance {start:${gen.provenance.start}, end:${gen.provenance.end}}, stateHash=${short(gen.stateHash)}, byte-identical to genesis replay`
);

// ---------------------------------------------------------------------------
// Stage 5 — REWIND PAST A NEST BOUNDARY: the compensating host receipt makes
// the double-entry net zero; the organ continues on the rewound tip.
// ---------------------------------------------------------------------------
const host = makeQuilt("host-rewind-demo");
quiltApply(host, { type: "init", cellId: "host-vibe", kind: "value", value: "v1" });
const organ = boot(base, { host });
organ.append({ type: "set", cellId: "subject", value: "A" });
organ.append({ type: "set", cellId: "subject", value: "B" });
organ.append({ type: "set", cellId: "subject", value: "C" });
const preTip = organ.ledger[organ.ledger.length - 1].seq;
const creditsBefore = host.ledger.filter((r) => r.op.type === "organ.credit").length;

const rw = rewind(organ, 4); // deep into pre-nest history — crosses the nest boundary
const comp = rw.compensating;
const de = verifyDoubleEntry(host, organ);
const hostStillVerifies = host.ledger.filter((r) => r.op.type === "organ.credit").length === creditsBefore; // nothing erased
stage(
  "5.rewind-past-nest",
  comp?.op?.type === ORGAN_REWIND_TYPE &&
    comp.op.rewound.length === 3 &&
    comp.op.fromSeq === preTip &&
    comp.op.toSeq === 4 &&
    de.ok &&
    de.creditsChecked === 0 &&
    de.creditsRevoked === 3 &&
    hostStillVerifies,
  `organ.rewind receipt at host seq ${comp.seq} revokes 3 credits (append-only: all 3 remain); double-entry nets to zero (${de.creditsChecked} live / ${de.creditsRevoked} revoked)`
);

const { debit } = organ.append({ type: "set", cellId: "subject", value: "after-rewind" });
const de2 = verifyDoubleEntry(host, organ);
const b2 = snapshotOrgan(organ);
const organ2 = boot(b2);
stage(
  "5b.continue-after-rewind",
  debit.seq === 5 && de2.ok && de2.creditsChecked === 1 && cellsStateHash(organ2.cells) === cellsStateHash(organ.cells),
  `organ continues from the rewound tip (debit seq ${debit.seq}); new credit pairs; re-snapshot (${b2.receipts.length} receipts) boots hash-equal in a fresh quilt`
);

// ---------------------------------------------------------------------------
// Stage 6 — REWIND AUDIT FAIL-CLOSED: padding the compensating receipt's
// evidence with a LIVE credit (re-hashed self-consistently) is caught.
// ---------------------------------------------------------------------------
const forgedHost = JSON.parse(JSON.stringify(host));
const rIdx = forgedHost.ledger.findIndex((r) => r.op.type === ORGAN_REWIND_TYPE);
// the attack: revoke a LIVE credit (the post-rewind append's credit, whose
// debit IS still carried) by padding the evidence list
const liveCredit = forgedHost.ledger.filter((r) => r.op.type === "organ.credit").pop();
forgedHost.ledger[rIdx].op.rewound.push({
  creditSeq: liveCredit.seq,
  creditHash: liveCredit.hash,
  organSeq: liveCredit.op.organSeq,
  debitHash: liveCredit.op.debitHash,
});
for (let i = rIdx; i < forgedHost.ledger.length; i++) {
  if (i > rIdx) forgedHost.ledger[i].prev = forgedHost.ledger[i - 1].hash;
  forgedHost.ledger[i].hash = receiptHash(forgedHost.ledger[i]);
}
const deF = verifyDoubleEntry(forgedHost, { organId: organ.organId, ledger: organ.ledger, nestReceipt: organ.nestReceipt });
// The attack is STRUCTURALLY impossible to forge: the evidence must carry the
// credit's hash, but that hash depends on the rewind receipt's hash (the
// credit's prev), which depends on the evidence — and the temporal form law
// (a listed credit must precede the rewind receipt) flags it independently.
const caughtCodes = deF.errors.map((e) => e.code);
stage(
  "6.rewind-audit-fail-closed",
  !deF.ok &&
    caughtCodes.includes("DOUBLE_ENTRY_REWIND_INVALID") &&
    caughtCodes.includes("DOUBLE_ENTRY_HASH_MISMATCH"),
  `self-consistent padding impossible — caught as [${[...new Set(caughtCodes)].join(", ")}]`
);

// ---------------------------------------------------------------------------
// Receipt file — committed evidence (no wall-clock in any hash; seq is time)
// ---------------------------------------------------------------------------
mkdirSync(join(dirname(fileURLToPath(import.meta.url)), "receipts"), { recursive: true });
const receiptPath = join(dirname(fileURLToPath(import.meta.url)), "receipts", "rewind-v1-demo-receipt.json");
const receipt = {
  schema: "quilt-jev-toolkit/rewind-v1-demo-receipt/v1",
  lane: "64-a",
  writtenAt: new Date().toISOString(),
  organ: { organId: base.manifest.organId, name: "greeter-organ" },
  transaction: {
    ops: 4,
    committed: true,
    fromManifestHash: base.manifest.manifestHash,
    toManifestHash: tx.bundle.manifest.manifestHash,
    fromStateHash: tx.fromStateHash,
    toStateHash: tx.toStateHash,
    supersedes: tx.bundle.manifest.supersedes,
    receipts: tx.bundle.receipts.length,
  },
  atomicity: { failedOp: failed.failedOp, code: failed.code, baseUnchanged: canonicalJson(base) === baseBytes },
  stateAt: { seq: 5, stateHash: at5.stateHash },
  rewindGenesis: { toSeq: 0, stateHash: gen.stateHash, provenance: gen.provenance },
  rewindPastNest: {
    fromSeq: preTip,
    toSeq: rw.provenance.end,
    compensating: { hostSeq: comp.seq, hash: comp.hash, revoked: comp.op.rewound.length },
    doubleEntry: { ok: de.ok, liveCredits: de.creditsChecked, revoked: de.creditsRevoked, rewinds: de.rewinds },
    hostLedgerLength: host.ledger.length,
    continuedDebitSeq: debit.seq,
    reSnapshotReceipts: b2.receipts.length,
    reBootedStateHash: cellsStateHash(organ2.cells),
  },
  audit: { paddedEvidenceCaught: !deF.ok, firstError: deF.errors[0]?.code },
  stages,
};
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
console.log(`\nreceipt written: ${receiptPath}`);
console.log(`organ says after rewind+continue: subject="${organ.cells.subject.value}"`);
if (process.exitCode) {
  console.error("REWIND DEMO FAILED — see [FAIL] stage above");
}
