// quilt-jev-toolkit — organ boot v0 (lane 63-c) + v2 partial custody (lane 65-b)
//
// boot(bundle, { host?, trustedCheckpoint?, checkpointKey? }) → organ instance
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
// Ed25519 is the v3 path; unknown algorithms refuse (CHECKPOINT_MALFORMED).

import { createHmac } from "node:crypto";
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
// v2 checkpoint signatures — HMAC-SHA256 over (manifestHash, chainTip, seq)
// ---------------------------------------------------------------------------

export const CHECKPOINT_SCHEMA = "quilt.organ.checkpoint";
export const CHECKPOINT_VERSION = 1;
export const CHECKPOINT_ALG = "HMAC-SHA256"; // Ed25519 is the v3 path; refuse others

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

/** Verify a SIGNED checkpoint document's structure and signature (no bundle
 *  needed). Returns { ok } or { ok:false, code, detail } with codes
 *  CHECKPOINT_MALFORMED / CHECKPOINT_SIGNATURE_INVALID. */
export function verifySignedCheckpoint(cp, key) {
  if (key === undefined || key === null || key === "" || (typeof key === "object" && key.length === 0)) {
    return { ok: false, code: "CHECKPOINT_SIGNATURE_REQUIRED", detail: "no usable checkpoint key was provided — an HMAC signature cannot verify without it" };
  }
  if (!cp || typeof cp !== "object" || Array.isArray(cp)) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: "checkpoint is not an object" };
  }
  if (cp.schema !== CHECKPOINT_SCHEMA || cp.schemaVersion !== CHECKPOINT_VERSION) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: `checkpoint schema ${JSON.stringify(cp.schema)}/${JSON.stringify(cp.schemaVersion)} not implemented (knows only ${CHECKPOINT_SCHEMA}/${CHECKPOINT_VERSION})` };
  }
  if (cp.alg !== CHECKPOINT_ALG) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: `checkpoint alg ${JSON.stringify(cp.alg)} not implemented (knows only ${CHECKPOINT_ALG}; Ed25519 is the v3 path)` };
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
  if (typeof cp.sig !== "string" || !HEX64.test(cp.sig)) {
    return { ok: false, code: "CHECKPOINT_MALFORMED", detail: "checkpoint sig missing or not sha256 hex" };
  }
  if (hmacHex(key, checkpointSigningPayload(cp)) !== cp.sig) {
    return { ok: false, code: "CHECKPOINT_SIGNATURE_INVALID", detail: `HMAC-${CHECKPOINT_ALG} does not verify under the provided key — forged signature, tampered signed fields, or wrong key` };
  }
  return { ok: true };
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
    const cp = bundle.checkpoint ?? opts.trustedCheckpoint ?? null;
    if (!cp) {
      fail("CUSTODY_GAP", `receipt range starts at seq ${manifest.genesis.seq} with a replay seed but no checkpoint — an UNSIGNED gap is still unowned history`);
      return out;
    }
    if (opts.checkpointKey === undefined || opts.checkpointKey === null || opts.checkpointKey === "") {
      fail("CHECKPOINT_SIGNATURE_REQUIRED", "partial custody needs the checkpoint key — the custody gap is legal only under a signature that covers the gap boundary");
      return out;
    }
    // 4a. the signature itself (structure + HMAC under the verifier's key)
    const sig = verifySignedCheckpoint(cp, opts.checkpointKey);
    if (!sig.ok) {
      fail(sig.code, sig.detail);
      return out;
    }
    // 4b. the boundary must sit within the carried receipts ...
    if (cp.seq > manifest.receiptRange.end) {
      fail("CHECKPOINT_SEQ_BEYOND_RECEIPTS", `checkpoint anchors seq ${cp.seq}, beyond the carried receipts (last seq ${manifest.receiptRange.end}) — there is no post-checkpoint receipt to verify against it`);
      return out;
    }
    // 4c. ... and pin the first carried receipt's parent exactly
    if (cp.seq !== manifest.genesis.seq - 1 || cp.hash !== manifest.genesis.prevHash) {
      fail("CUSTODY_CHECKPOINT_MISMATCH", `checkpoint {seq:${cp.seq}, hash:${cp.hash}} does not pin the first carried receipt's parent {seq:${manifest.genesis.seq - 1}, hash:${manifest.genesis.prevHash}}`);
      return out;
    }
    // 4d. the anchor manifest: content-addressed against the SIGNED manifestHash
    //     — the signature anchors the seed through this second hash hop
    const anchor = cp.manifest;
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) {
      fail("CHECKPOINT_MALFORMED", "signed checkpoint carries no prefix manifest — the replay seed cannot be anchored");
      return out;
    }
    const av = validateManifest(anchor);
    if (!av.ok
        || computeManifestHash(anchor) !== cp.manifestHash
        || anchor.receiptRange.start !== 0
        || anchor.receiptRange.end !== cp.seq
        || anchor.genesis.seq !== 0
        || anchor.genesis.prevHash !== GENESIS
        || anchor.organId !== manifest.organId) {
      fail("CHECKPOINT_ANCHOR_MISMATCH", `checkpoint prefix manifest does not re-hash to the signed manifestHash ${cp.manifestHash} (or is not a full-prefix manifest of organ ${manifest.organId} ending at seq ${cp.seq})`);
      return out;
    }
    // 4e. the seed: the state AT the boundary, anchored via the prefix manifest
    let seedHash;
    try {
      seedHash = cellsStateHash(partialSeed.cells);
    } catch (e) {
      fail("CHECKPOINT_SEED_MISMATCH", `seed state not canonicalizable: ${e.message}`);
      return out;
    }
    if (partialSeed.seq !== cp.seq || seedHash !== anchor.state.cellsSha256) {
      fail("CHECKPOINT_SEED_MISMATCH", partialSeed.seq !== cp.seq
        ? `seed claims seq ${JSON.stringify(partialSeed.seq)}, checkpoint anchors seq ${cp.seq}`
        : `seed state hash ${seedHash} does not match the signature-anchored prefix state ${anchor.state.cellsSha256} — the seed was tampered`);
      return out;
    }
    replayBase = JSON.parse(canonicalJson(partialSeed.cells));
    out.custody = {
      kind: "signed-checkpoint",
      anchoredAt: cp.seq,
      signedAt: { seq: cp.seq, hash: cp.hash, manifestHash: cp.manifestHash, alg: cp.alg },
      seedStateHash: seedHash,
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
 * @param bundle { manifest, state, receipts, seed?, checkpoint? }
 * @param opts   { host?: quilt, trustedCheckpoint?: {seq, hash}|signedCp, checkpointKey?: string }
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
  // (the replay floor for every later prefix query/rewind).
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
      checkpoint: JSON.parse(canonicalJson(bundle.checkpoint ?? opts.trustedCheckpoint)),
    };
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
