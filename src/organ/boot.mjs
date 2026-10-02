// quilt-jev-toolkit — organ boot v0 (lane 63-c) + v2 partial custody (lane 65-b)
//                           + v3 Ed25519 attribution + key rotation (lane 68-b)
//
// boot(bundle, { host?, trustedCheckpoint?, checkpointKey?, checkpointKeys? }) → organ instance
//
// Spec (docs/REVERSE-ACTUALIZED-SPEC.md §2 + §8): boot is the courtroom where the
// snapshot's custody claim is either PROVEN or THROWN OUT:
//   1. manifest validates (SCHEMA_DRIFT / MANIFEST_INVALID)
//   2. carried state hashes recompute (STATE_HASH_MISMATCH)
//   3. every receipt hash re-verifies, chain contiguous (CHAIN_GAP / RECEIPT_HASH_MISMATCH)
//   4. custody anchor: GENESIS, a pinned trustedCheckpoint, or — v2 — a SIGNED
//      checkpoint over a partial-custody replay seed (CUSTODY_GAP /
//      CUSTODY_CHECKPOINT_MISMATCH / CHECKPOINT_SIGNATURE_REQUIRED /
//      CHECKPOINT_SIGNATURE_INVALID / CHECKPOINT_MALFORMED /
//      CHECKPOINT_SEQ_BEYOND_RECEIPTS / CHECKPOINT_ANCHOR_MISMATCH /
//      CHECKPOINT_SEED_MISMATCH)
//   5. deterministic replay of the range == carried state — from empty cells
//      (full custody) or from the signature-anchored seed (partial custody)
//      (REPLAY_DIVERGENCE / REPLAY_INVALID_OP)
//   6. only then does the organ exist — and optionally nests into a host.
//
// Boot never partially succeeds: any failure throws OrganBootError, nothing else.
//
// v2 checkpoint law (§8): the custody GAP becomes CONDITIONAL. A bundle that
// carries only receipts [checkpointSeq+1..tip] plus a replay seed boots IF (and
// only if) an HMAC-SHA256 signature under the verifier's key covers the gap
// boundary (manifestHash, chainTip, seq). The signature anchors the seed
// through two content-address hops: signed manifestHash → carried prefix
// manifest → seed state hash. Unsigned gap = fail-closed (unchanged).
//
// v3 attribution law (§10): the signer gets a NAME. An Ed25519 checkpoint is
// verified through the SAME doorway — the public key IS the trust root (no
// shared secret), the checkpoint names its signer by publicKeyFingerprint
// (sha256 of the signer's SPKI PEM), and a key mismatch is a signature
// failure, not a fallback. Key rotation: a bundle may carry a CHAIN of
// checkpoints (bundle.checkpoints, ascending seq) — era 0 anchors the carried
// seed; every later era's anchored state is proven by REPLAY from the previous
// era's anchor, so each key is checked against its own era and the chain of
// custody survives key rotation. Unknown algorithms refuse (CHECKPOINT_MALFORMED).

import { createHmac } from "node:crypto";
import {
  ED25519_ALG,
  ED25519_SIG_HEX,
  ed25519PublicKeyFingerprint,
  ed25519VerifyHex,
} from "./ed25519.mjs";
import {
  GENESIS,
  canonicalJson,
  computeManifestHash,
  makeReceipt,
  sha256Json,
  validateManifest,
  verifyChain,
} from "./manifest.mjs";
import { applyOp } from "./toyQuilt.mjs";
import { cellsStateHash } from "./snapshot.mjs";
import { appendCredit, nestInto } from "./nest.mjs";

export class OrganBootError extends Error {
  constructor(code, detail) {
    super(`[${code}] ${detail}`);
    this.name = "OrganBootError";
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// checkpoint signatures — v2: HMAC-SHA256; v3: Ed25519 (attribution)
// over (manifestHash, chainTip, seq)
// ---------------------------------------------------------------------------

export const CHECKPOINT_SCHEMA = "quilt.organ.checkpoint";
export const CHECKPOINT_VERSION = 1;
export const CHECKPOINT_ALG = "HMAC-SHA256"; // v2 (shared secret — no signer identity)
export { ED25519_ALG as CHECKPOINT_ALG_ED25519 }; // v3 (asymmetric — the key holds the trust)

const HEX64 = /^[0-9a-f]{64}$/;

/** The exact canonical bytes the signature covers: the sorted-key canonical
 *  JSON of the triple {hash, manifestHash, seq}. Mint (checkpoint.mjs) and
 *  verify (here) MUST produce these bytes identically. */
export function checkpointSigningPayload(cp) {
  return canonicalJson({ hash: cp.hash, manifestHash: cp.manifestHash, seq: cp.seq });
}

function hmacHex(key, payload) {
  const k = typeof key === "string" ? Buffer.from(key, "utf8") : key;
  return createHmac("sha256", k).update(payload, "utf8").digest("hex");
}

/** 4d shared (v2 era 0 + v3 rotation eras): the checkpoint's anchor manifest
 *  must be a valid FULL-prefix manifest of the organ, ending exactly at the
 *  checkpoint's seq, and re-hash to the SIGNED manifestHash. */
function anchorManifestVerdict(cp, organId) {
  const anchor = cp.manifest;
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: "signed checkpoint carries no prefix manifest — the replay seed cannot be anchored" };
  }
  const av = validateManifest(anchor);
  if (!av.ok
      || computeManifestHash(anchor) !== cp.manifestHash
      || anchor.receiptRange.start !== 0
      || anchor.receiptRange.end !== cp.seq
      || anchor.genesis.seq !== 0
      || anchor.genesis.prevHash !== GENESIS
      || anchor.organId !== organId) {
    return { ok: false, code: "CHECKPOINT_ANCHOR_MISMATCH", detail: `checkpoint prefix manifest does not re-hash to the signed manifestHash ${cp.manifestHash} (or is not a full-prefix manifest of organ ${organId} ending at seq ${cp.seq})` };
  }
  return { ok: true, anchor };
}

/** v3 custody provenance: WHO anchored this era. Ed25519 names its key by
 *  fingerprint (identity); a shared-secret HMAC has no name — every writer
 *  holds full signing power, so attribution is fleet-trust (the honest
 *  residual, now receipted in the provenance itself). */
function signerOf(cp) {
  return cp.alg === ED25519_ALG
    ? { kind: "ed25519", anchoredAt: cp.seq, publicKeyFingerprint: cp.publicKeyFingerprint }
    : { kind: "hmac-sha256", anchoredAt: cp.seq };
}

/** Verify a SIGNED checkpoint document's structure and signature (no bundle
 *  needed). Returns { ok } or { ok:false, code, detail } with codes
 *  CHECKPOINT_MALFORMED / CHECKPOINT_SIGNATURE_REQUIRED /
 *  CHECKPOINT_SIGNATURE_INVALID.
 *
 *  The key is alg-relative keying material: for v2 (HMAC-SHA256) the shared
 *  secret; for v3 (Ed25519) the verifier's PUBLIC key PEM — the key HOLDS the
 *  trust, and the checkpoint must name that key's fingerprint exactly. */
export function verifySignedCheckpoint(cp, key) {
  if (key === undefined || key === null || key === "" || (typeof key === "object" && key.length === 0)) {
    return { ok: false, code: "CHECKPOINT_SIGNATURE_REQUIRED", detail: "no usable checkpoint key was provided — a signed checkpoint cannot verify without its keying material" };
  }
  if (!cp || typeof cp !== "object" || Array.isArray(cp)) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: "checkpoint is not an object" };
  }
  if (cp.schema !== CHECKPOINT_SCHEMA || cp.schemaVersion !== CHECKPOINT_VERSION) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: `checkpoint schema ${JSON.stringify(cp.schema)}/${JSON.stringify(cp.schemaVersion)} not implemented (knows only ${CHECKPOINT_SCHEMA}/${CHECKPOINT_VERSION})` };
  }
  if (cp.alg !== CHECKPOINT_ALG && cp.alg !== ED25519_ALG) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: `checkpoint alg ${JSON.stringify(cp.alg)} not implemented (knows only ${CHECKPOINT_ALG} and ${ED25519_ALG}; anything else refuses fail-closed)` };
  }
  if (!Number.isInteger(cp.seq) || cp.seq < 0) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: `checkpoint seq must be a non-negative integer, got ${JSON.stringify(cp.seq)}` };
  }
  if (typeof cp.hash !== "string" || !HEX64.test(cp.hash)) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: "checkpoint hash (chainTip at seq) missing or not sha256 hex" };
  }
  if (typeof cp.manifestHash !== "string" || !HEX64.test(cp.manifestHash)) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: "checkpoint manifestHash missing or not sha256 hex" };
  }
  if (cp.alg === ED25519_ALG) {
    // v3: the checkpoint NAMES its signer; the verifier's key must be exactly
    // that key (fingerprint equality), then the signature must verify under it.
    if (typeof cp.publicKeyFingerprint !== "string" || !HEX64.test(cp.publicKeyFingerprint)) {
      return { ok: false, code: "CHECKPOINT_MALFORMED", detail: "ed25519 checkpoint carries no usable publicKeyFingerprint (expected 64-hex sha256 of the signer's SPKI PEM)" };
    }
    if (typeof cp.sig !== "string" || !ED25519_SIG_HEX.test(cp.sig)) {
      return { ok: false, code: "CHECKPOINT_MALFORMED", detail: "checkpoint sig missing or not a 128-hex Ed25519 signature" };
    }
    let fp;
    try {
      fp = ed25519PublicKeyFingerprint(key);
    } catch {
      return { ok: false, code: "CHECKPOINT_SIGNATURE_INVALID", detail: "provided checkpoint key is not usable Ed25519 key material (PEM unparseable) — the trust root itself is malformed" };
    }
    if (fp !== cp.publicKeyFingerprint) {
      return { ok: false, code: "CHECKPOINT_SIGNATURE_INVALID", detail: `checkpoint names signer ${cp.publicKeyFingerprint.slice(0, 12)}… but the provided key's fingerprint is ${fp.slice(0, 12)}… — wrong key` };
    }
    if (!ed25519VerifyHex(key, checkpointSigningPayload(cp), cp.sig)) {
      return { ok: false, code: "CHECKPOINT_SIGNATURE_INVALID", detail: "Ed25519 signature does not verify under the provided public key — forged signature, tampered signed fields, or wrong key" };
    }
    return { ok: true };
  }
  if (typeof cp.sig !== "string" || !HEX64.test(cp.sig)) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: "checkpoint sig missing or not sha256 hex" };
  }
  if (hmacHex(key, checkpointSigningPayload(cp)) !== cp.sig) {
    return { ok: false, code: "CHECKPOINT_SIGNATURE_INVALID", detail: `HMAC-${CHECKPOINT_ALG} does not verify under the provided key — forged signature, tampered signed fields, or wrong key` };
  }
  return { ok: true };
}

/** The explicit v3 doorway: verify an Ed25519 checkpoint under a public key
 *  PEM — the key HOLDS the trust, no shared secret exists. Same law as
 *  verifySignedCheckpoint (which dispatches on alg); this is the named v3
 *  spelling for verifiers that know which trust root they hold. */
export function verifyCheckpointEd25519(cp, publicKeyPem) {
  if (!cp || typeof cp !== "object" || Array.isArray(cp)) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: "checkpoint is not an object" };
  }
  if (cp.alg !== ED25519_ALG) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: `verifyCheckpointEd25519: checkpoint alg ${JSON.stringify(cp.alg)} is not ${ED25519_ALG} (use verifySignedCheckpoint for the alg-dispatching doorway)` };
  }
  return verifySignedCheckpoint(cp, publicKeyPem);
}

/** Verify a bundle without booting it: manifest + state hashes + chain +
 *  (optionally) custody anchor + replay. Returns
 *  { ok, errors, stateHash, tipHash, replayedCells?, custody? }. */
export function verifyBundle(bundle, opts = {}) {
  const errors = [];
  const fail = (code, detail) => errors.push({ code, detail });
  const out = { ok: false, errors, stateHash: null, tipHash: null };

  if (!bundle || typeof bundle !== "object") {
    fail("MANIFEST_INVALID", "bundle is not an object");
    return out;
  }
  const { manifest, state, receipts } = bundle;

  // -- 1. manifest ----------------------------------------------------------
  const mv = validateManifest(manifest);
  if (!mv.ok) {
    errors.push(...mv.errors);
    return out;
  }

  // -- 2. carried state hashes ---------------------------------------------
  if (!state || typeof state !== "object" || !state.cells || typeof state.cells !== "object") {
    fail("STATE_HASH_MISMATCH", "bundle.state.cells missing");
    return out;
  }
  const cells = state.cells;
  let stateOk = true;
  try {
    const recomputed = cellsStateHash(cells);
    out.stateHash = recomputed;
    if (recomputed !== manifest.state.cellsSha256) {
      fail("STATE_HASH_MISMATCH", `state.cellsSha256: recomputed ${recomputed}, manifest claims ${manifest.state.cellsSha256}`);
      stateOk = false;
    }
    for (const c of manifest.cells) {
      const cell = cells[c.id];
      if (!cell) {
        fail("STATE_HASH_MISMATCH", `manifest cell ${c.id} absent from carried state`);
        stateOk = false;
        continue;
      }
      const h = sha256Json({ kind: cell.kind, value: cell.value });
      if (h !== c.stateHash) {
        fail("STATE_HASH_MISMATCH", `cell ${c.id}: recomputed ${h}, manifest claims ${c.stateHash}`);
        stateOk = false;
      }
    }
  } catch (e) {
    fail("STATE_HASH_MISMATCH", `state not canonicalizable: ${e.message}`);
    return out;
  }
  if (!stateOk) return out;

  // -- 3. receipt chain ------------------------------------------------------
  if (!Array.isArray(receipts)) {
    fail("CHAIN_GAP", "bundle.receipts is not an array");
    return out;
  }
  if (receipts.length !== manifest.receiptRange.count) {
    fail("CHAIN_GAP", `receipts.length ${receipts.length} != receiptRange.count ${manifest.receiptRange.count}`);
    return out;
  }
  const cv = verifyChain(receipts, { expectedStart: manifest.receiptRange.start, expectedPrev: manifest.genesis.prevHash });
  if (!cv.ok) {
    fail(cv.code, cv.detail);
    return out;
  }
  if (receipts[receipts.length - 1].seq !== manifest.receiptRange.end) {
    fail("CHAIN_GAP", `last receipt seq ${receipts[receipts.length - 1].seq} != receiptRange.end ${manifest.receiptRange.end}`);
    return out;
  }
  out.tipHash = cv.tipHash;

  // -- 4. custody anchor ----------------------------------------------------
  // v2: bundle.seed present ⇒ PARTIAL CUSTODY — the prefix [0..cp.seq] is not
  // carried; the gap is legal only under a signature covering the boundary.
  const partialSeed = bundle.seed ?? null;
  let replayBase = null; // null ⇒ replay from empty cells (v0 law); else the anchored seed

  if (partialSeed !== null && manifest.genesis.seq === 0) {
    fail("MANIFEST_INVALID", "bundle carries a partial-custody replay seed but its manifest claims the full chain from GENESIS — contradictory custody claim");
    return out;
  }

  if (partialSeed !== null) {
    if (!partialSeed || typeof partialSeed !== "object" || Array.isArray(partialSeed)
        || !partialSeed.cells || typeof partialSeed.cells !== "object" || Array.isArray(partialSeed.cells)) {
      fail("CHECKPOINT_SEED_MISMATCH", "bundle.seed carries no replay seed cells");
      return out;
    }
    // v3 key rotation: bundle.checkpoints (ascending chain, one key per era)
    // or the v2 singular bundle.checkpoint / opts.trustedCheckpoint. Both at
    // once is a contradictory custody claim.
    const hasSingular = (bundle.checkpoint ?? opts.trustedCheckpoint) !== undefined && (bundle.checkpoint ?? opts.trustedCheckpoint) !== null;
    if (bundle.checkpoints !== undefined && hasSingular) {
      fail("CHECKPOINT_MALFORMED", "bundle carries both `checkpoint` and `checkpoints` — contradictory custody claims");
      return out;
    }
    let cps; // [{ cp, key }]
    if (bundle.checkpoints !== undefined) {
      if (!Array.isArray(bundle.checkpoints) || bundle.checkpoints.length === 0
          || bundle.checkpoints.some((c) => !c || typeof c !== "object" || Array.isArray(c))) {
        fail("CHECKPOINT_MALFORMED", "bundle.checkpoints must be a non-empty array of checkpoint objects");
        return out;
      }
      for (let i = 1; i < bundle.checkpoints.length; i++) {
        if (!Number.isInteger(bundle.checkpoints[i].seq) || !Number.isInteger(bundle.checkpoints[i - 1].seq)
            || bundle.checkpoints[i].seq <= bundle.checkpoints[i - 1].seq) {
          fail("CHECKPOINT_MALFORMED", `checkpoints must have strictly ascending seqs (era ${i - 1} anchors seq ${bundle.checkpoints[i - 1].seq}, era ${i} anchors ${JSON.stringify(bundle.checkpoints[i].seq)})`);
          return out;
        }
      }
      const keys = opts.checkpointKeys ?? (opts.checkpointKey !== undefined ? [opts.checkpointKey] : undefined);
      if (!Array.isArray(keys) || keys.length !== bundle.checkpoints.length) {
        fail("CHECKPOINT_SIGNATURE_REQUIRED", `rotation chain carries ${bundle.checkpoints.length} checkpoint eras but ${keys === undefined ? "no" : keys.length} keys were provided — every era needs its own keying material (HMAC secret or Ed25519 public key)`);
        return out;
      }
      cps = bundle.checkpoints.map((cp, i) => ({ cp, key: keys[i] }));
    } else {
      const cp = bundle.checkpoint ?? opts.trustedCheckpoint ?? null;
      if (!cp) {
        fail("CUSTODY_GAP", `receipt range starts at seq ${manifest.genesis.seq} with a replay seed but no checkpoint — an UNSIGNED gap is still unowned history`);
        return out;
      }
      if (opts.checkpointKey === undefined || opts.checkpointKey === null || opts.checkpointKey === "") {
        fail("CHECKPOINT_SIGNATURE_REQUIRED", "partial custody needs the checkpoint key — the custody gap is legal only under a signature that covers the gap boundary");
        return out;
      }
      cps = [{ cp, key: opts.checkpointKey }];
    }

    // 4a–4e, era 0: the signature anchors the carried seed (v2 law unchanged).
    const c0 = cps[0].cp;
    const sig0 = verifySignedCheckpoint(c0, cps[0].key);
    if (!sig0.ok) {
      fail(sig0.code, sig0.detail);
      return out;
    }
    if (c0.seq > manifest.receiptRange.end) {
      fail("CHECKPOINT_SEQ_BEYOND_RECEIPTS", `checkpoint anchors seq ${c0.seq}, beyond the carried receipts (last seq ${manifest.receiptRange.end}) — there is no post-checkpoint receipt to verify against it`);
      return out;
    }
    if (c0.seq !== manifest.genesis.seq - 1 || c0.hash !== manifest.genesis.prevHash) {
      fail("CUSTODY_CHECKPOINT_MISMATCH", `checkpoint {seq:${c0.seq}, hash:${c0.hash}} does not pin the first carried receipt's parent {seq:${manifest.genesis.seq - 1}, hash:${manifest.genesis.prevHash}}`);
      return out;
    }
    const anchor0 = anchorManifestVerdict(c0, manifest.organId);
    if (!anchor0.ok) {
      fail(anchor0.code, anchor0.detail);
      return out;
    }
    let seedHash;
    try {
      seedHash = cellsStateHash(partialSeed.cells);
    } catch (e) {
      fail("CHECKPOINT_SEED_MISMATCH", `seed state not canonicalizable: ${e.message}`);
      return out;
    }
    if (partialSeed.seq !== c0.seq || seedHash !== anchor0.anchor.state.cellsSha256) {
      fail("CHECKPOINT_SEED_MISMATCH", partialSeed.seq !== c0.seq
        ? `seed claims seq ${JSON.stringify(partialSeed.seq)}, checkpoint anchors seq ${c0.seq}`
        : `seed state hash ${seedHash} does not match the signature-anchored prefix state ${anchor0.anchor.state.cellsSha256} — the seed was tampered`);
      return out;
    }
    replayBase = JSON.parse(canonicalJson(partialSeed.cells));

    // 4f. v3 ROTATION: every later era is proven by REPLAY from the previous
    //     era's anchor — key_i is checked against ITS era only, and the chain
    //     of custody crosses key boundaries through the signed anchor states.
    const signers = [signerOf(c0)];
    for (let i = 1; i < cps.length; i++) {
      const cp = cps[i].cp;
      const sig = verifySignedCheckpoint(cp, cps[i].key); // era i's key, era i's sig
      if (!sig.ok) {
        fail(sig.code, `rotation era ${i} (seq ${cp.seq}): ${sig.detail}`);
        return out;
      }
      if (cp.seq > manifest.receiptRange.end) {
        fail("CHECKPOINT_SEQ_BEYOND_RECEIPTS", `rotation era ${i} anchors seq ${cp.seq}, beyond the carried receipts (last seq ${manifest.receiptRange.end})`);
        return out;
      }
      // replay (prev era boundary, this era boundary] from the era-i-1 anchor
      const eraCells = JSON.parse(canonicalJson(replayBase));
      for (const r of receipts) {
        if (r.seq <= cps[i - 1].cp.seq) continue;
        if (r.seq > cp.seq) break;
        try {
          applyOp(eraCells, r.op);
        } catch (e) {
          fail("REPLAY_INVALID_OP", `rotation era ${i}: replay failed at seq ${r.seq} (${r.op?.type}): ${e.message}`);
          return out;
        }
      }
      const idx = cp.seq - manifest.receiptRange.start;
      if (cp.hash !== receipts[idx].hash) {
        fail("CUSTODY_CHECKPOINT_MISMATCH", `rotation era ${i} checkpoint {seq:${cp.seq}, hash:${cp.hash}} does not pin the carried receipt at that seq (${receipts[idx].hash.slice(0, 12)}…) — genuine key, wrong chain`);
        return out;
      }
      const av = anchorManifestVerdict(cp, manifest.organId);
      if (!av.ok) {
        fail(av.code, `rotation era ${i}: ${av.detail}`);
        return out;
      }
      let eraHash;
      try {
        eraHash = cellsStateHash(eraCells);
      } catch (e) {
        fail("CUSTODY_CHECKPOINT_MISMATCH", `rotation era ${i}: replayed era state not canonicalizable: ${e.message}`);
        return out;
      }
      if (eraHash !== av.anchor.state.cellsSha256) {
        fail("CUSTODY_CHECKPOINT_MISMATCH", `rotation era ${i} (key ${i}) anchors state ${av.anchor.state.cellsSha256.slice(0, 12)}… at seq ${cp.seq}, but replay from era ${i - 1}'s anchored seed produces ${eraHash.slice(0, 12)}… — the custody chain does not cross this key boundary`);
        return out;
      }
      replayBase = eraCells;
      signers.push(signerOf(cp));
    }

    out.custody = {
      kind: "signed-checkpoint",
      anchoredAt: c0.seq,
      signedAt: { seq: c0.seq, hash: c0.hash, manifestHash: c0.manifestHash, alg: c0.alg },
      seedStateHash: seedHash,
      signer: signers[0],
      ...(cps.length > 1 ? { signers } : {}),
    };
  } else if (manifest.genesis.seq > 0) {
    const cp = opts.trustedCheckpoint;
    if (!cp || typeof cp !== "object") {
      fail("CUSTODY_GAP", `receipt range starts at seq ${manifest.genesis.seq} with no trustedCheckpoint — an unverifiable prefix is unowned history`);
      return out;
    }
    if (cp.seq !== manifest.genesis.seq - 1 || cp.hash !== manifest.genesis.prevHash) {
      fail("CUSTODY_CHECKPOINT_MISMATCH", `trustedCheckpoint {seq:${cp.seq}, hash:${cp.hash}} does not pin the first carried receipt's parent {seq:${manifest.genesis.seq - 1}, hash:${manifest.genesis.prevHash}}`);
      return out;
    }
  } else if (manifest.genesis.prevHash !== GENESIS) {
    fail("CUSTODY_CHECKPOINT_MISMATCH", `genesis receipt at seq 0 must anchor prev=${GENESIS}`);
    return out;
  }

  // -- 5. deterministic replay ----------------------------------------------
  // Full custody: replay from empty cells (v0 law). Partial custody: replay
  // from the SIGNATURE-ANCHORED seed — only the post-checkpoint receipts are
  // re-applied; genesis is never replayed (the scale path).
  const replayed = replayBase ?? {};
  for (const r of receipts) {
    try {
      applyOp(replayed, r.op);
    } catch (e) {
      fail("REPLAY_INVALID_OP", `replay failed at seq ${r.seq} (${r.op?.type}): ${e.message}`);
      return out;
    }
  }
  let replayHash;
  try {
    replayHash = cellsStateHash(replayed);
  } catch (e) {
    fail("REPLAY_DIVERGENCE", `replayed state not canonicalizable: ${e.message}`);
    return out;
  }
  if (replayHash !== manifest.state.cellsSha256) {
    fail("REPLAY_DIVERGENCE", `replay ${replayBase ? "from the anchored seed at seq " + out.custody.anchoredAt + " over the carried receipts" : "of the receipt range from empty cells"} produces ${replayHash}, carried state claims ${manifest.state.cellsSha256}`);
    return out;
  }

  out.ok = true;
  out.replayedCells = replayed;
  return out;
}

/**
 * Boot an organ from a bundle. Fail-closed: throws OrganBootError on any
 * violated invariant; on success returns a live organ instance:
 * { organId, name, manifest, cells, ledger, host, nestReceipt, append(op) }.
 *
 * @param bundle { manifest, state, receipts, seed?, checkpoint?, checkpoints? }
 * @param opts   { host?: quilt, trustedCheckpoint?: {seq, hash}|signedCp,
 *                 checkpointKey?: string|pem, checkpointKeys?: (string|pem)[] }
 */
export function boot(bundle, opts = {}) {
  const verdict = verifyBundle(bundle, opts);
  if (!verdict.ok) {
    const first = verdict.errors[0];
    const err = new OrganBootError(first.code, verdict.errors.map((e) => `[${e.code}] ${e.detail}`).join(" | "));
    err.errors = verdict.errors;
    throw err;
  }

  // The organ wakes with the REPLAYED state — what replay proves, not what
  // the bundle merely claims (they are asserted equal above anyway).
  const organ = {
    organId: bundle.manifest.organId,
    name: bundle.manifest.name,
    manifest: JSON.parse(canonicalJson(bundle.manifest)),
    cells: verdict.replayedCells,
    ledger: bundle.receipts.map((r) => JSON.parse(canonicalJson(r))),
    host: null,
    nestReceipt: null,
    custody: null,
  };
  // v2 partial custody: the organ carries its custody provenance — where the
  // signature anchored it, which range replay verified, and the seed cells
  // (the replay floor for every later prefix query/rewind). v3: WHO anchored
  // it — signer (era 0) and, under rotation, the full per-era signer chain.
  if (verdict.custody) {
    organ.custody = {
      kind: "signed-checkpoint",
      signedAt: verdict.custody.signedAt,
      verifiedRange: { start: bundle.manifest.genesis.seq, end: bundle.manifest.receiptRange.end },
      seed: {
        seq: bundle.seed.seq,
        cells: JSON.parse(canonicalJson(bundle.seed.cells)),
        stateHash: verdict.custody.seedStateHash,
      },
      checkpoint: JSON.parse(canonicalJson(bundle.checkpoint ?? opts.trustedCheckpoint ?? bundle.checkpoints[0])),
    };
    if (verdict.custody.signer) organ.custody.signer = verdict.custody.signer;
    if (verdict.custody.signers) organ.custody.signers = verdict.custody.signers;
  }
  organ.append = (op) => organAppend(organ, op);

  if (opts.host) nestInto(opts.host, bundle, organ);
  return organ;
}

/** Append an op to a booted organ's own ledger (debit). If nested, writes the
 *  matching host credit (double entry). Delegated here so boot.mjs owns the
 *  organ shape; nest.mjs owns the envelope. */
function organAppend(organ, op) {
  // Local import dance avoided: nest.mjs exports this behavior for organs
  // with a host; standalone organs append here.
  const last = organ.ledger[organ.ledger.length - 1];
  const debit = makeReceipt(last.seq + 1, op, last.hash);
  applyOp(organ.cells, op); // fail-closed before the ledger moves
  organ.ledger.push(debit);
  let credit = null;
  if (organ.host) {
    credit = appendCredit(organ.host, {
      organId: organ.organId,
      organSeq: debit.seq,
      debitHash: debit.hash,
      stateHashAfter: cellsStateHash(organ.cells),
    });
  }
  return { debit, credit };
}
