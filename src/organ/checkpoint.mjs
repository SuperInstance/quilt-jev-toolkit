// quilt-jev-toolkit — organ checkpoint minting + partial-custody carving (v2, lane 65-b)
//
// Spec (docs/REVERSE-ACTUALIZED-SPEC.md §8): a checkpoint is a SIGNED custody
// anchor. Minting replays the prefix once at checkpoint time and signs the
// triple (manifestHash, chainTip, seq) with HMAC-SHA256 under the minter's
// key (Ed25519 is the v3 path):
//
//   signCheckpoint(bundle, seq, key)
//     → { schema: "quilt.organ.checkpoint", schemaVersion: 1, alg: "HMAC-SHA256",
//         seq, hash: <receipt seq's hash>, manifestHash: <prefix snapshot's hash>,
//         sig: <HMAC(key, canonical({hash, manifestHash, seq}))>,
//         manifest: <the prefix snapshot's manifest, hash-addressed to manifestHash> }
//
// The signed manifestHash anchors the replay SEED (the state at seq) through
// two content-address hops: sig → manifestHash → prefix manifest → seed state
// hash. A verifier holding the key can therefore trust a bundle that carries
// only receipts [seq+1..tip] + the seed + this checkpoint — the custody gap
// becomes CONDITIONAL (boot.mjs enforces it; unsigned gaps still refuse).
//
// The scale property: minting pays the genesis replay ONCE; every later boot
// replays only the post-checkpoint receipts. Boot a 10-million-receipt organ
// without replaying genesis.
//
// Trust law (honest scope): the signature anchors the PREFIX (state at seq,
// boundary receipt hash, organ identity). Post-checkpoint custody is the v0
// law as usual — hash-linked receipts + replay == carried state. Minting and
// carving are keyless-mechanical except for the HMAC itself; verification is
// boot's courtroom (boot.mjs), never skipped.

import { createHmac } from "node:crypto";
import { canonicalJson } from "./manifest.mjs";
import { applyOp } from "./toyQuilt.mjs";
import { freezeJson, snapshot } from "./snapshot.mjs";
import {
  OrganBootError,
  verifyBundle,
  CHECKPOINT_SCHEMA,
  CHECKPOINT_VERSION,
  CHECKPOINT_ALG,
  checkpointSigningPayload,
} from "./boot.mjs";

function hmacHex(key, payload) {
  if (key === undefined || key === null || key === "" || (typeof key === "object" && key.length === 0)) {
    throw new OrganBootError("CHECKPOINT_SIGNATURE_REQUIRED", "signing needs a non-empty key (string or Buffer)");
  }
  const k = typeof key === "string" ? Buffer.from(key, "utf8") : key;
  return createHmac("sha256", k).update(payload, "utf8").digest("hex");
}

/** Replay the prefix [start..seq] of a FULL-custody bundle into the seed cells. */
function prefixCellsOf(bundle, idx) {
  const cells = {};
  for (let i = 0; i <= idx; i++) {
    applyOp(cells, bundle.receipts[i].op); // bundle is verified — ops apply cleanly
  }
  return cells;
}

/** Build the canonical prefix snapshot manifest for the boundary at seq.
 *  Deterministic in (bundle, seq): carving re-derives this exact manifest and
 *  refuses a checkpoint doc that does not match it byte-for-byte. */
function prefixManifestOf(bundle, seq) {
  const idx = seq - bundle.manifest.receiptRange.start;
  const prefixCells = prefixCellsOf(bundle, idx);
  return snapshot(prefixCells, bundle.receipts.slice(0, idx + 1), {
    name: bundle.manifest.name,
    organId: bundle.manifest.organId,
    edges: bundle.manifest.edges,
    supersedes: null, // a custody anchor is not a lineage re-snapshot
  }).manifest;
}

/**
 * MINT a signed checkpoint: verify the bundle through the full boot courtroom
 * (fail-closed — never sign an unproven snapshot), replay the prefix once,
 * snapshot the prefix, and HMAC the triple (prefix manifestHash, chainTip at
 * seq, seq) under the key.
 *
 * @param bundle a FULL-custody bundle (genesis.seq === 0; a partial-custody
 *               bundle does not carry the prefix and cannot mint)
 * @param seq    boundary: last receipt the checkpoint covers (≤ tip; a
 *               checkpoint AT the tip is legal but covers the whole chain)
 * @param key    non-empty string or Buffer
 * @returns the signed checkpoint document (carries its prefix manifest)
 */
export function signCheckpoint(bundle, seq, key) {
  if (!bundle || typeof bundle !== "object" || !bundle.manifest) {
    throw new OrganBootError("CHECKPOINT_MINT_INVALID", "signCheckpoint: bundle is not an organ bundle {manifest, state, receipts}");
  }
  if (bundle.manifest.genesis.seq !== 0) {
    throw new OrganBootError("CHECKPOINT_MINT_INVALID", `cannot mint a custody anchor from a partial-custody bundle (genesis.seq ${bundle.manifest.genesis.seq}) — the prefix [0..${bundle.manifest.genesis.seq - 1}] is not carried here; mint from the full chain`);
  }
  const verdict = verifyBundle(bundle);
  if (!verdict.ok) {
    const first = verdict.errors[0];
    const err = new OrganBootError(first.code, `signCheckpoint: refusing to sign an unproven snapshot — ${verdict.errors.map((e) => `[${e.code}] ${e.detail}`).join(" | ")}`);
    err.errors = verdict.errors;
    throw err;
  }
  const { start, end } = bundle.manifest.receiptRange;
  if (!Number.isInteger(seq) || seq < start || seq > end) {
    throw new OrganBootError("CHECKPOINT_SEQ_OUT_OF_RANGE", `checkpoint boundary seq ${JSON.stringify(seq)} is outside the carried range [${start}, ${end}]`);
  }

  const prefix = prefixManifestOf(bundle, seq);
  const cp = {
    schema: CHECKPOINT_SCHEMA,
    schemaVersion: CHECKPOINT_VERSION,
    alg: CHECKPOINT_ALG,
    seq,
    hash: bundle.receipts[seq - start].hash,
    manifestHash: prefix.manifestHash,
  };
  cp.sig = hmacHex(key, checkpointSigningPayload(cp));
  cp.manifest = freezeJson(prefix);
  return cp;
}

/**
 * CARVE a partial-custody bundle: given a full bundle and a signed checkpoint
 * at seq, produce the bundle that carries ONLY receipts [seq+1..tip] plus the
 * replay seed and the checkpoint. Keyless and mechanical — carving re-derives
 * the prefix manifest from the verified bundle and refuses a checkpoint that
 * does not match it (the key only matters at boot verification).
 *
 * @returns the partial bundle { manifest, state, receipts, seed, checkpoint }
 *   whose manifest is re-based: receiptRange [seq+1..tip], genesis pinned to
 *   the checkpoint's chainTip, supersedes = the source manifestHash.
 */
export function carvePartialCustody(bundle, checkpoint) {
  if (!bundle || typeof bundle !== "object" || !bundle.manifest) {
    throw new OrganBootError("CHECKPOINT_MINT_INVALID", "carvePartialCustody: bundle is not an organ bundle {manifest, state, receipts}");
  }
  if (bundle.manifest.genesis.seq !== 0) {
    throw new OrganBootError("CHECKPOINT_MINT_INVALID", `cannot carve from a partial-custody bundle (genesis.seq ${bundle.manifest.genesis.seq}) — the full chain is needed to re-derive the seed`);
  }
  const verdict = verifyBundle(bundle);
  if (!verdict.ok) {
    const first = verdict.errors[0];
    const err = new OrganBootError(first.code, `carvePartialCustody: refusing to carve an unproven snapshot — ${verdict.errors.map((e) => `[${e.code}] ${e.detail}`).join(" | ")}`);
    err.errors = verdict.errors;
    throw err;
  }
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new OrganBootError("CHECKPOINT_MALFORMED", "carvePartialCustody: checkpoint is not an object");
  }
  const { start, end } = bundle.manifest.receiptRange;
  const seq = checkpoint.seq;
  if (!Number.isInteger(seq) || seq < start || seq >= end) {
    throw new OrganBootError("CHECKPOINT_SEQ_OUT_OF_RANGE", seq === end
      ? `a checkpoint at the chain tip (seq ${seq}) covers the whole chain — there are no post-checkpoint receipts to carry; boot the full bundle instead`
      : `checkpoint boundary seq ${JSON.stringify(seq)} cannot split the carried range [${start}, ${end}] into a non-empty post-checkpoint tail`);
  }

  // The checkpoint must describe THIS bundle's prefix exactly.
  const prefix = prefixManifestOf(bundle, seq);
  if (canonicalJson(prefix) !== canonicalJson(checkpoint.manifest ?? null)
      || checkpoint.manifestHash !== prefix.manifestHash
      || checkpoint.hash !== bundle.receipts[seq - start].hash) {
    throw new OrganBootError("CHECKPOINT_ANCHOR_MISMATCH", `checkpoint does not describe this bundle's prefix at seq ${seq} — wrong chain, wrong boundary, or a swapped prefix manifest`);
  }

  const idx = seq - start;
  const partial = snapshot(bundle.state.cells, bundle.receipts.slice(idx + 1), {
    name: bundle.manifest.name,
    organId: bundle.manifest.organId,
    edges: bundle.manifest.edges,
    supersedes: bundle.manifest.manifestHash, // honest lineage: carved from this manifest
  });
  partial.seed = freezeJson({ seq, cells: prefixCellsOf(bundle, idx) });
  partial.checkpoint = freezeJson(checkpoint);
  return partial;
}
