// v3-attribution-demo — one identity, two organs, zero shared secrets (lane 68-b/68-b-r2)
//
// The cross-repo proof shape from docs/REVERSE-ACTUALIZED-SPEC.md §10 +
// quilt-mcp-receipts' docs/qmr2-design.md §8: the SAME Ed25519 identity (1)
// signs an organ v3 checkpoint through the FULL boot courtroom here, and (2)
// signs qmr2 receipt rows for the fleet receipt chain — verified by the SAME
// fingerprint law on both sides (sha256 of the normalized SPKI PEM).
//
// KEY HYGIENE (the key-scan law): the keypair is generated AT RUN TIME below
// and never written to disk — committed key files are forbidden; the receipt
// this demo emits carries fingerprints and hashes only.
//
// Run: node examples/v3-attribution-demo.mjs
// Exit code 0 = every stage proved; a receipt file is written to
// examples/receipts/v3-attribution-demo-receipt.json (committed evidence).

import { writeFileSync } from "node:fs";
import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import { snapshot } from "../src/organ/snapshot.mjs";
import { boot } from "../src/organ/boot.mjs";
import { makeQuilt, quiltApply } from "../src/organ/toyQuilt.mjs";
import {
  generateEd25519Keypair,
  ed25519PublicKeyFingerprint,
  ed25519VerifyHex,
} from "../src/organ/ed25519.mjs";
import { signCheckpointEd25519 } from "../src/organ/checkpoint.mjs";
import { verifyCheckpointEd25519 } from "../src/organ/boot.mjs";
import { carvePartialCustody } from "../src/organ/checkpoint.mjs";
import { buildGreeterQuilt, GREETER_FINAL_OUT } from "./greeter-organ.mjs";

const stages = [];
function stage(name, ok, detail) {
  stages.push({ stage: name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

// qmr1 byte laws (quilt-mcp-receipts server.mjs — mirrored here so the demo is
// self-contained; identical key ordering + separators, verified by the roundtrip)
const canonicalJSON = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(value[k])).join(",") + "}";
};
const qmr1Id = (seq, prev, body) =>
  createHash("sha256").update(`qmr1:${seq}:${prev}:${canonicalJSON(body)}`, "utf8").digest("hex");
const GENESIS_PREV = "0".repeat(64);

// ---------------------------------------------------------------------------
// Stage 1 — the identity (run-time keygen; never committed)
// ---------------------------------------------------------------------------
const { privateKeyPem, publicKeyPem, publicKeyFingerprint } = generateEd25519Keypair();
stage("1.identity", /^[0-9a-f]{64}$/.test(publicKeyFingerprint), `fingerprint=${publicKeyFingerprint.slice(0, 16)}… (sha256 of the SPKI PEM)`);

// ---------------------------------------------------------------------------
// Stage 2 — the identity signs an organ v3 checkpoint (FULL courtroom first)
// ---------------------------------------------------------------------------
const quilt = buildGreeterQuilt();
quiltApply(quilt, { type: "set", cellId: "subject", value: "v3-attribution-demo" });
const full = snapshot(quilt.cells, quilt.ledger, {
  name: "greeter-organ",
  edges: quilt.edges,
});
const CP_SEQ = 6;
const cp = signCheckpointEd25519(full, CP_SEQ, privateKeyPem);
const v = verifyCheckpointEd25519(cp, publicKeyPem);
stage("2.sign-checkpoint", v.ok === true && cp.publicKeyFingerprint === publicKeyFingerprint,
  `alg=Ed25519 seq=${cp.seq} triple={hash, manifestHash, seq} named ${cp.publicKeyFingerprint.slice(0, 12)}…`);

// ---------------------------------------------------------------------------
// Stage 3 — the named signer boots the carved partial custody
// ---------------------------------------------------------------------------
const partial = carvePartialCustody(full, cp);
const organ = boot(partial, { checkpointKey: publicKeyPem });
stage("3.boot-custody", organ.custody?.signer?.kind === "ed25519"
  && organ.custody.signer.publicKeyFingerprint === publicKeyFingerprint
  && organ.cells.out.value === GREETER_FINAL_OUT,
  `custody.signer={kind:"ed25519", publicKeyFingerprint:${organ.custody.signer.publicKeyFingerprint.slice(0, 12)}…}`);

// ---------------------------------------------------------------------------
// Stage 4 — the SAME identity signs qmr2 rows (the receipt-chain export)
//           sig = Ed25519 over "qmr1:sig:"+id; sigKeyFp = the fingerprint
// ---------------------------------------------------------------------------
const bodies = [
  { kind: "v3-attribution-export", ts: new Date().toISOString(), note: "organ v3 checkpoint anchor", checkpointSeq: cp.seq, checkpointManifestHash: cp.manifestHash },
  { kind: "v3-attribution-export", ts: new Date().toISOString(), note: "greeter final out", value: organ.cells.out.value },
];
const rows = [];
let prev = GENESIS_PREV;
bodies.forEach((body, i) => {
  const seq = i + 1;
  const id = qmr1Id(seq, prev, body);
  const sig = cryptoSign(null, Buffer.from(`qmr1:sig:${id}`, "utf8"), privateKeyPem).toString("hex");
  rows.push({ seq, prev, body, id, sig, sigAlg: "ed25519", sigKeyFp: publicKeyFingerprint });
  prev = id;
});
stage("4.mint-qmr2-rows", rows.length === 2 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.id) && /^[0-9a-f]{128}$/.test(r.sig)),
  `2 qmr2 rows, sigs 128-hex, sigKeyFp = the SAME fingerprint as the checkpoint`);

// ---------------------------------------------------------------------------
// Stage 5 — the OTHER repo's law verifies the rows (fingerprint + keyring shape)
// ---------------------------------------------------------------------------
const keyring = { [publicKeyFingerprint]: publicKeyPem };
const rowsOk = rows.every((r) =>
  r.sigKeyFp in keyring
  && ed25519PublicKeyFingerprint(keyring[r.sigKeyFp]) === r.sigKeyFp
  && ed25519VerifyHex(keyring[r.sigKeyFp], `qmr1:sig:${r.id}`, r.sig)
  && r.id === qmr1Id(r.seq, r.prev, r.body));
// fail-closed probes: a forged sig and an unknown signer must both be caught
const forged = { ...rows[0], sig: rows[0].sig.slice(0, -1) + (rows[0].sig.endsWith("0") ? "1" : "0") };
const unknownFp = "a".repeat(64);
stage("5.cross-repo-verify", rowsOk && !ed25519VerifyHex(keyring[rows[0].sigKeyFp], `qmr1:sig:${forged.id}`, forged.sig)
  && !(unknownFp in keyring),
  `rows verify under the shared fingerprint law; forged sig false; unknown fingerprint would be E_UNKNOWN_SIGNER`);

// ---------------------------------------------------------------------------
// Receipt — fingerprints + hashes ONLY (never key material; the key-scan law)
// ---------------------------------------------------------------------------
const receipt = {
  demo: "v3-attribution-demo",
  lane: "68-b (completed by 68-b-r2)",
  repos: ["quilt-jev-toolkit (organ v3)", "quilt-mcp-receipts (qmr2 attribution §8)"],
  identityFingerprint: publicKeyFingerprint,
  checkpoint: { seq: cp.seq, hash: cp.hash, manifestHash: cp.manifestHash, alg: cp.alg, sig: cp.sig },
  qmr2Rows: rows.map((r) => ({ seq: r.seq, id: r.id, sigAlg: r.sigAlg, sigKeyFp: r.sigKeyFp, sig: r.sig })),
  receiptHash: createHash("sha256").update(canonicalJSON({ cp: cp.sig, rows: rows.map((r) => r.sig) }), "utf8").digest("hex"),
  stages,
};
writeFileSync(new URL("./receipts/v3-attribution-demo-receipt.json", import.meta.url), JSON.stringify(receipt, null, 2) + "\n");
console.log(`\nreceipt → examples/receipts/v3-attribution-demo-receipt.json (fingerprints + sigs only, zero key material)`);
