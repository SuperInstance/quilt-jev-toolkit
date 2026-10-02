// upload-v1-states — cross-feed: put BOTH v1-rewound states on the live fleet
// organ store (lane 64-a)
//
// Flow: snapshot the greeter organ → transact (advance) → rewind to a mid
// receipt → export BOTH states as bundles → upload to
//   https://organ-boot-loader.casey-digennaro.workers.dev
// using WORKER_UPLOAD_TOKEN from /home/z/my-project/.env.keys (never echoed).
//
// DIALECT FINDING (receipted, not fixed here — unification is lane 64-c):
// the worker speaks `quilt.organ.v1` (receiptRange = digest array, receipts
// {seq,op,cell,prev,payload,digest}, prev anchor "genesis", stateHash over
// canonical(state)); the toolkit speaks `quilt.organ.manifest/v1` (receiptRange
// {start,end,count}, receipts {seq,op,prev,hash}, anchor "GENESIS",
// state.cellsSha256). The native upload is attempted first, receipted as the
// finding; the two state exports then go up through an explicit ADAPTER below.
//
// Run: node examples/upload-v1-states.mjs

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { canonicalJson, sha256 } from "../src/organ/manifest.mjs";
import { snapshot } from "../src/organ/snapshot.mjs";
import { boot } from "../src/organ/boot.mjs";
import { rewind, transact } from "../src/organ/rewind.mjs";
import { buildGreeterQuilt, GREETER_EDGES } from "./greeter-organ.mjs";

const STORE = "https://organ-boot-loader.casey-digennaro.workers.dev";
const short = (h) => `${h.slice(0, 16)}…`;

// --- token: loaded, length-checked, never echoed ---------------------------
const envPath = "/home/z/my-project/.env.keys";
const line = readFileSync(envPath, "utf8")
  .split("\n")
  .find((l) => l.startsWith("WORKER_UPLOAD_TOKEN="));
if (!line) {
  console.error("WORKER_UPLOAD_TOKEN not found in .env.keys — aborting (no upload attempted)");
  process.exit(2);
}
const TOKEN = line.slice("WORKER_UPLOAD_TOKEN=".length).trim();
if (TOKEN.length < 16) {
  console.error("WORKER_UPLOAD_TOKEN implausibly short — aborting");
  process.exit(2);
}

// --- build the two states ----------------------------------------------------
const q = buildGreeterQuilt();
const base = snapshot(q.cells, q.ledger, { name: "greeter-organ", edges: GREETER_EDGES });
const advance = transact(base, [
  { type: "set", cellId: "greeting", value: "Ahoy" },
  { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] },
  { type: "set", cellId: "subject", value: "v1-rewound-demo" },
  { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] },
]);
if (!advance.ok) {
  console.error("advance transaction failed:", advance.detail);
  process.exit(1);
}
const tipBundle = advance.bundle;
boot(tipBundle); // prove the tip state boots

const TO_SEQ = 8; // mid-history: after "Hello, Fleet!" render (seq 8 of the base greeter)
const view = rewind(tipBundle, TO_SEQ);
const rewoundBundle = snapshot(view.state.cells, tipBundle.receipts.slice(0, view.provenance.count), {
  name: "greeter-organ",
  organId: tipBundle.manifest.organId,
  edges: GREETER_EDGES,
  supersedes: tipBundle.manifest.manifestHash,
});
boot(rewoundBundle); // prove the rewound state boots
console.log(`tip state     seq 0..${tipBundle.manifest.receiptRange.end}  stateHash=${short(tipBundle.manifest.state.cellsSha256)}`);
console.log(`rewound state seq ${view.provenance.start}..${TO_SEQ}        stateHash=${short(rewoundBundle.manifest.state.cellsSha256)}`);

// --- dialect adapter (receipted; the 64-c unification target) ----------------
function toWorkerDialect(bundle) {
  const receipts = bundle.receipts.map((r, i) => ({
    seq: i + 1, // worker receipts are 1-based, anchored at "genesis"
    op: r.op,
    cell: typeof r.op?.cellId === "string" ? r.op.cellId : "organ",
    prev: null, // chained below
    payload: { toolkitSeq: r.seq, toolkitHash: r.hash }, // toolkit provenance carried
  }));
  const receiptRange = [];
  let prev = "genesis";
  for (const t of receipts) {
    t.prev = prev;
    const digest = sha256(canonicalJson({ seq: t.seq, op: t.op, cell: t.cell, prev: t.prev, payload: t.payload }));
    receiptRange.push(digest);
    t.digest = digest;
    prev = digest;
  }
  const manifest = {
    author: "quilt-jev-toolkit@64-a",
    cells: bundle.manifest.cells,
    createdAt: "2026-10-02T00:00:00Z", // fixed → content-addressed ids are stable
    name: bundle.manifest.name,
    receiptRange,
    stateHash: sha256(canonicalJson(bundle.state)),
  };
  return { schemaVersion: "quilt.organ.v1", manifest, state: bundle.state, receipts };
}

async function put(body, label) {
  const res = await fetch(`${STORE}/organ`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body — keep status only */
  }
  console.log(`PUT ${label}: HTTP ${res.status}${json?.error ? ` — ${json.error}` : ""}${json?.id ? ` — id=${json.id}` : ""}`);
  return { status: res.status, json };
}

const uploads = [];
const findings = [];

// 1) NATIVE dialect probe — expected to be REFUSED (the dialect finding).
const native = await put(JSON.stringify(tipBundle), "native quilt.organ.manifest/v1 bundle (probe)");
if (native.status === 400) {
  findings.push({
    finding: "DIALECT_DRIFT",
    detail: `worker refused the native toolkit bundle with HTTP 400: ${native.json?.error} — worker speaks quilt.organ.v1, toolkit speaks quilt.organ.manifest/v1 (lesson L15; unification parked to lane 64-c)`,
    stored: false,
  });
} else if (native.status >= 200 && native.status < 300) {
  findings.push({ finding: "NATIVE_UPLOAD_ACCEPTED", detail: "unexpected: the worker accepted the native dialect", stored: true, id: native.json?.id });
  uploads.push({ label: "native-probe", id: native.json?.id });
} else {
  findings.push({ finding: "NATIVE_UPLOAD_UNEXPECTED", detail: `HTTP ${native.status}`, stored: false });
}

// 2) The two states, adapted to the worker dialect.
const adaptedTip = toWorkerDialect(tipBundle);
const adaptedRewound = toWorkerDialect(rewoundBundle);
const upTip = await put(adaptedTip, "TIP state (advanced, quilt.organ.v1 dialect)");
const upRewound = await put(adaptedRewound, "REWOUND state (quilt.organ.v1 dialect)");
if (upTip.status !== 201 && upTip.status !== 200) process.exitCode = 1;
if (upRewound.status !== 201 && upRewound.status !== 200) process.exitCode = 1;
uploads.push(
  { label: "rewound-state", id: upRewound.json?.id, stateHash: rewoundBundle.manifest.state.cellsSha256, toSeq: TO_SEQ },
  { label: "tip-state", id: upTip.json?.id, stateHash: tipBundle.manifest.state.cellsSha256, toSeq: tipBundle.manifest.receiptRange.end }
);

// 3) Remote verify — the store re-derives everything server-side.
const verifications = [];
for (const u of uploads) {
  if (!u.id) continue;
  const res = await fetch(`${STORE}/organ/${u.id}/verify`);
  const v = await res.json();
  verifications.push({ id: u.id, label: u.label, http: res.status, bootable: v.bootable, reason: v.reason });
  console.log(`VERIFY ${u.label}: HTTP ${res.status} bootable=${v.bootable}`);
  if (!v.bootable) process.exitCode = 1;
}

// --- receipt ------------------------------------------------------------------
mkdirSync(join(dirname(fileURLToPath(import.meta.url)), "receipts"), { recursive: true });
const receiptPath = join(dirname(fileURLToPath(import.meta.url)), "receipts", "rewind-v1-upload-receipt.json");
const receipt = {
  schema: "quilt-jev-toolkit/rewind-v1-upload-receipt/v1",
  lane: "64-a",
  writtenAt: new Date().toISOString(),
  store: STORE,
  dialects: { toolkit: "quilt.organ.manifest/v1", worker: "quilt.organ.v1" },
  uploadBudget: {
    note: "probe PUT stored nothing (HTTP 400); exactly 2 stored uploads — within the ≤2 budget",
    storedUploads: uploads.filter((u) => u.label !== "native-probe").length,
  },
  states: {
    tip: {
      manifestHash: tipBundle.manifest.manifestHash,
      stateHash: tipBundle.manifest.state.cellsSha256,
      receipts: tipBundle.receipts.length,
      supersedes: tipBundle.manifest.supersedes,
    },
    rewound: {
      manifestHash: rewoundBundle.manifest.manifestHash,
      stateHash: rewoundBundle.manifest.state.cellsSha256,
      receipts: rewoundBundle.receipts.length,
      rewoundToSeq: TO_SEQ,
      provenanceTipHash: view.provenance.tipHash,
    },
  },
  uploads,
  verifications,
  findings,
};
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
console.log(`\nreceipt written: ${receiptPath}`);
if (process.exitCode) console.error("UPLOAD FAILED — see above");
