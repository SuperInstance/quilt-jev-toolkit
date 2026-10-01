// quilt-jev-toolkit — organ boot v0 (lane 63-c)
//
// boot(bundle, { host?, trustedCheckpoint? }) → organ instance
//
// Spec (docs/REVERSE-ACTUALIZED-SPEC.md §2): boot is the courtroom where the
// snapshot's custody claim is either PROVEN or THROWN OUT:
//   1. manifest validates (SCHEMA_DRIFT / MANIFEST_INVALID)
//   2. carried state hashes recompute (STATE_HASH_MISMATCH)
//   3. every receipt hash re-verifies, chain contiguous (CHAIN_GAP / RECEIPT_HASH_MISMATCH)
//   4. custody anchor: GENESIS or pinned trustedCheckpoint (CUSTODY_GAP / CUSTODY_CHECKPOINT_MISMATCH)
//   5. deterministic replay of the range == carried state (REPLAY_DIVERGENCE / REPLAY_INVALID_OP)
//   6. only then does the organ exist — and optionally nests into a host.
//
// Boot never partially succeeds: any failure throws OrganBootError, nothing else.

import {
  GENESIS,
  canonicalJson,
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

/** Verify a bundle without booting it: manifest + state hashes + chain +
 *  (optionally) custody anchor + replay. Returns
 *  { ok, errors, stateHash, tipHash, replayedCells? }. */
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
  if (manifest.genesis.seq > 0) {
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
  const replayed = {};
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
    fail("REPLAY_DIVERGENCE", `replay of the receipt range produces ${replayHash}, carried state claims ${manifest.state.cellsSha256}`);
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
 * @param bundle { manifest, state, receipts }
 * @param opts   { host?: quilt, trustedCheckpoint?: {seq, hash} }
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
  };
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
