// quilt-jev-toolkit — organ rewind family + write-side transactions (v1 lane 64-a, v2 lane 65-b)
//
// Spec (docs/REVERSE-ACTUALIZED-SPEC.md §7): the rewind family is the QUESTION's
// first verb. v1 adds:
//
//   stateAt(subject, seq)   pure query — "what did the cells look like at
//                           receipt seq?" No mutation, no host side-effects.
//   rewind(subject, toSeq)  bundle form: pure view (same as stateAt).
//                           organ form: DESTRUCTIVE rewind — the organ's ledger
//                           truncates to `toSeq`, cells are rebuilt by pure
//                           replay, and if the organ is nested in a host that
//                           crosses the nest boundary, the host receives the
//                           COMPENSATING receipt { type: "organ.rewind", ... } —
//                           the double-entry discipline applied backwards.
//   transact(bundle, ops)   two-phase write: PREPARE stages every op on
//                           detached copies and validates each against the
//                           post-op state; COMMIT materializes the successor
//                           bundle exactly once. Any op failure → the input
//                           bundle is byte-untouched and the failure names the
//                           op index + code. All ops or nothing.
//
// Fail-closed law (v0 carried forward): the subject is fully re-verified before
// any rewind/transact view is produced — a forged chain is caught by
// REPLAY_DIVERGENCE whether you boot it, rewind it, or write to it.
//
// v2 partial custody: a subject booted from a SIGNED checkpoint (bundle.seed /
// organ.custody) replays prefixes FROM THE SEED, not from empty cells — the
// checkpoint boundary is the custody floor. Rewinding below the floor is
// impossible without the full chain and refuses with REWIND_PAST_CUSTODY,
// naming the checkpoint; rewind/stateAt above it are byte-equal to the full
// bundle's answers (the seed is signature-anchored, proven at boot).
//
// Append-only discipline (never delete data): the host ledger is never
// rewritten. A rewind does not erase the superseded host credits — it appends
// an organ.rewind receipt that REVOKES them and carries their
// {creditSeq, creditHash, organSeq, debitHash} pointers as evidence. The
// organ's own ledger truncation is the rewind itself; the rewound debits stay
// recoverable from the host evidence plus any pre-rewind snapshot.

import {
  canonicalJson,
  makeReceipt,
  verifyChain,
} from "./manifest.mjs";
import { applyOp } from "./toyQuilt.mjs";
import { cellsStateHash, freezeJson, snapshot } from "./snapshot.mjs";
import { verifyBundle, OrganBootError } from "./boot.mjs";
import { appendHostReceipt } from "./nest.mjs";

/** Host receipt type emitted as the compensating entry for an organ rewind. */
export const ORGAN_REWIND_TYPE = "organ.rewind";

const fail = (code, detail) => {
  throw new OrganBootError(code, detail);
};

function isBootedOrgan(subject) {
  return (
    subject !== null &&
    typeof subject === "object" &&
    Array.isArray(subject.ledger) &&
    subject.cells !== null &&
    typeof subject.cells === "object" &&
    typeof subject.append === "function"
  );
}

function isBundle(subject) {
  return (
    subject !== null &&
    typeof subject === "object" &&
    subject.manifest !== null &&
    typeof subject.manifest === "object" &&
    subject.state !== null &&
    typeof subject.state === "object" &&
    Array.isArray(subject.receipts)
  );
}

/** Resolve the replay base for a subject: empty cells (v0 full custody) or the
 *  signature-anchored seed (v2 partial custody). For an organ, also re-asserts
 *  the seed's in-memory integrity against its boot-verified hash. */
function replayBaseOf(subject) {
  const custody = subject.custody;
  if (!custody || custody.kind !== "signed-checkpoint") return { base: {}, anchoredAt: null };
  if (!custody.seed || !custody.seed.cells) {
    fail("REPLAY_DIVERGENCE", "partial-custody subject carries no replay seed — the custody floor is unrecoverable");
  }
  let seedHash;
  try {
    seedHash = cellsStateHash(custody.seed.cells);
  } catch (e) {
    fail("REPLAY_DIVERGENCE", `custody seed not canonicalizable: ${e.message}`);
  }
  if (seedHash !== custody.seed.stateHash) {
    fail("REPLAY_DIVERGENCE", `custody seed hash ${seedHash} != boot-verified ${custody.seed.stateHash} — the seed was tampered after boot`);
  }
  return { base: freezeJson(custody.seed.cells), anchoredAt: custody.signedAt.seq };
}

/** Resolve { receipts, genesisSeq, tipSeq, verify } for either subject kind.
 *  Bundle subjects are verified through the full boot courtroom (fail-closed:
  * REPLAY_DIVERGENCE fires for forged chains even on a pure query). Organ
  * subjects get the equivalent in-memory courtroom: chain verify + replay ==
  * carried cells. */
function courtroom(subject, opts = {}) {
  if (isBootedOrgan(subject)) {
    const receipts = subject.ledger;
    if (receipts.length === 0) fail("CHAIN_GAP", "organ ledger is empty");
    const first = receipts[0];
    const cv = verifyChain(receipts, { expectedStart: first.seq, expectedPrev: first.prev });
    if (!cv.ok) fail(cv.code, `organ ledger fails its own chain verify: ${cv.detail}`);
    const { base, anchoredAt } = replayBaseOf(subject);
    const replayed = freezeJson(base); // the courtroom's own copy — base stays the pristine replay floor
    for (const r of receipts) {
      try {
        applyOp(replayed, r.op);
      } catch (e) {
        fail("REPLAY_INVALID_OP", `organ ledger replay failed at seq ${r.seq}: ${e.message}`);
      }
    }
    const replayHash = cellsStateHash(replayed);
    const carriedHash = cellsStateHash(subject.cells);
    if (replayHash !== carriedHash) {
      fail("REPLAY_DIVERGENCE", `organ cells ${carriedHash} != replay of its own ledger ${replayHash}`);
    }
    return { kind: "organ", organ: subject, receipts, genesisSeq: first.seq, tipSeq: receipts[receipts.length - 1].seq, base, anchoredAt };
  }
  if (isBundle(subject)) {
    const verdict = verifyBundle(subject, opts);
    if (!verdict.ok) {
      const first = verdict.errors[0];
      fail(first.code, `bundle fails verification before the operation may run: ${verdict.errors.map((e) => `[${e.code}] ${e.detail}`).join(" | ")}`);
    }
    const base = subject.seed ? freezeJson(subject.seed.cells) : {};
    return {
      kind: "bundle",
      bundle: subject,
      receipts: subject.receipts,
      genesisSeq: subject.manifest.genesis.seq,
      tipSeq: subject.manifest.receiptRange.end,
      base,
      anchoredAt: verdict.custody ? verdict.custody.anchoredAt : null,
    };
  }
  fail("REWIND_TARGET_INVALID", "subject is neither a bundle {manifest, state, receipts} nor a booted organ");
}

/** Resolve and bound-check the target seq. Returns the inclusive index of the
 *  target receipt in `receipts`. */
function resolveTarget(court, toSeq) {
  if (!Number.isInteger(toSeq)) {
    fail("REWIND_TARGET_INVALID", `toSeq must be an integer, got ${JSON.stringify(toSeq)}`);
  }
  if (toSeq < court.genesisSeq) {
    if (court.anchoredAt != null) {
      fail("REWIND_PAST_CUSTODY", `toSeq ${toSeq} is before the carried range start ${court.genesisSeq} — pre-checkpoint history is not carried (custody anchored by a signed checkpoint at seq ${court.anchoredAt}); without the full chain, rewind below the custody boundary is impossible`);
    }
    fail("REWIND_PAST_CUSTODY", `toSeq ${toSeq} is before the carried range start ${court.genesisSeq} — a prefix the bundle does not carry is unowned history (checkpoint custody starts at genesis.seq)`);
  }
  if (toSeq > court.tipSeq) {
    fail("REWIND_TARGET_INVALID", `toSeq ${toSeq} is beyond the chain tip ${court.tipSeq} — rewind moves backwards; to advance, boot and append`);
  }
  return toSeq - court.genesisSeq;
}

/** Pure prefix replay: state AS OF receipt `seq` (inclusive). Starts from
 *  `base` — empty cells under full custody, the anchored seed under partial
 *  custody (v2). */
function prefixState(receipts, toIdx, base = {}) {
  const cells = freezeJson(base);
  for (let i = 0; i <= toIdx; i++) {
    applyOp(cells, receipts[i].op); // courtroom already proved these apply cleanly
  }
  return cells;
}

function provenanceOf(court, toSeq, tipHash) {
  return {
    start: court.genesisSeq,
    end: toSeq,
    count: toSeq - court.genesisSeq + 1,
    tipHash,
    carriedRange: { start: court.genesisSeq, end: court.tipSeq, count: court.tipSeq - court.genesisSeq + 1 },
    anchoredAt: court.anchoredAt ?? null, // v2: the signed checkpoint boundary, null under full custody
  };
}

/**
 * TIME-TRAVEL QUERY (pure): what did the cells look like at receipt `seq`?
 * Works on a bundle or a booted organ; never mutates anything, never writes
 * host receipts. Returns
 *   { seq, state: {cells}, stateHash, provenance: {start, end, count, tipHash, carriedRange} }.
 */
export function stateAt(subject, seq, opts = {}) {
  const court = courtroom(subject, opts);
  const toIdx = resolveTarget(court, seq);
  const cells = prefixState(court.receipts, toIdx, court.base);
  return {
    seq,
    state: { cells },
    stateHash: cellsStateHash(cells),
    provenance: provenanceOf(court, seq, court.receipts[toIdx].hash),
  };
}

/**
 * REWIND.
 *
 * Bundle form (pure): returns { state: {cells}, stateHash, provenance } — a
 * verified view AS OF `toSeq`. The input bundle is untouched.
 *
 * Organ form (destructive, the host-aware rewind): the organ's ledger
 * truncates to `toSeq` and its cells are rebuilt by pure replay — byte-equal
 * to what a fresh boot of a toSeq-truncated bundle would produce. If the
 * organ is nested in a host and the rewind revokes any host credit, the host
 * ledger receives exactly one compensating receipt
 *   { type: "organ.rewind", organId, fromSeq, toSeq, stateHashAfter,
 *     rewound: [{creditSeq, creditHash, organSeq, debitHash}, ...] }
 * — the reverse of nest's debit/credit pair, append-only (nothing is erased;
 * the superseded credits remain in the host ledger, marked revoked).
 * Returns { state, stateHash, provenance, rewoundFrom, compensating }.
 */
export function rewind(subject, toSeq, opts = {}) {
  const court = courtroom(subject, opts);
  const toIdx = resolveTarget(court, toSeq);

  if (court.kind === "bundle") {
    const cells = prefixState(court.receipts, toIdx, court.base);
    return {
      state: { cells },
      stateHash: cellsStateHash(cells),
      provenance: provenanceOf(court, toSeq, court.receipts[toIdx].hash),
    };
  }

  // -- organ form: destructive rewind with compensating host receipt --------
  const organ = court.organ;
  const rewoundFrom = court.tipSeq;
  const prefixCells = prefixState(court.receipts, toIdx, court.base);
  const prefixHash = cellsStateHash(prefixCells);

  // Compute the compensating evidence BEFORE truncating (the host credits for
  // organSeq > toSeq are exactly the ones the rewind revokes).
  let compensating = null;
  if (organ.host) {
    const rewoundCredits = organ.host.ledger
      .filter((r) => r.op?.type === "organ.credit" && r.op.organId === organ.organId && r.op.organSeq > toSeq)
      .map((r) => ({ creditSeq: r.seq, creditHash: r.hash, organSeq: r.op.organSeq, debitHash: r.op.debitHash }));
    if (rewoundCredits.length > 0) {
      compensating = appendHostReceipt(organ.host, {
        type: ORGAN_REWIND_TYPE,
        organId: organ.organId,
        fromSeq: rewoundFrom,
        toSeq,
        stateHashAfter: prefixHash,
        rewound: rewoundCredits,
      });
    }
  }

  // Truncate + rebuild. The organ continues from the rewound tip: appending
  // afterwards extends the SAME hash chain from seq toSeq — custody unbroken.
  organ.ledger = court.receipts.slice(0, toIdx + 1).map((r) => JSON.parse(canonicalJson(r)));
  organ.cells = prefixCells;
  if (organ.host && organ.nestReceipt && organ.nestReceipt.op.organSeq > toSeq) {
    // Rewound past the nest boundary itself: the nest marker stays in the host
    // ledger (append-only history) but no longer pins a live tip. Mark it so
    // downstream audits know the organ outlives that nesting moment.
    organ.nestReceipt = { ...organ.nestReceipt, supersededBy: compensating ? compensating.hash : null };
  }

  return {
    state: { cells: organ.cells },
    stateHash: prefixHash,
    provenance: provenanceOf(court, toSeq, court.receipts[toIdx].hash),
    rewoundFrom,
    compensating,
  };
}

/**
 * WRITE-SIDE TRANSACTION: transact(bundle, ops) — all ops or nothing.
 *
 * Phase PREPARE: the base bundle is verified through the full boot courtroom
 * (forged base → OrganBootError, v0 law), then every op is staged in order on
 * DETACHED copies of the cells, each validated against the post-op state of
 * the ops before it (the deterministic evaluator is the validator: a set on a
 * missing cell, a duplicate init, a render on a missing placeholder all throw).
 * The first failure returns
 *   { ok: false, phase: "prepare", failedOp, code, detail, appliedCount, errors }
 * and the input bundle is byte-untouched.
 *
 * Phase COMMIT: exactly once, the successor bundle is materialized via
 * snapshot() — same organId (identity carried), receiptRange extended by the
 * staged receipts, state hash recomputed, `supersedes` pinned to the input
 * manifestHash — and self-verified through verifyBundle before returning, so
 * a committed bundle is one that would boot. No intermediate partially-extended
 * bundle ever exists.
 *
 * opts: { trustedCheckpoint? } — forwarded to the base courtroom.
 */
export function transact(bundle, ops, opts = {}) {
  if (!Array.isArray(ops)) fail("TRANSACTION_INVALID", "ops must be an array");
  const court = courtroom(bundle, opts);
  if (court.kind !== "bundle") {
    fail("TRANSACTION_INVALID", "transact() writes to a bundle; a booted organ appends through organ.append (organ-granularity transactions are parked — docs/REVERSE-ACTUALIZED-SPEC.md §7)");
  }
  const base = court.bundle;
  const fromStateHash = base.manifest.state.cellsSha256;

  if (ops.length === 0) {
    return {
      ok: true,
      unchanged: true,
      appliedCount: 0,
      bundle: freezeJson(base),
      newReceipts: [],
      fromStateHash,
      toStateHash: fromStateHash,
    };
  }

  // ---- PREPARE: stage on detached copies, validate every op ----------------
  const working = freezeJson(base.state.cells);
  const baseReceipts = court.receipts;
  let prev = baseReceipts[baseReceipts.length - 1].hash;
  let nextSeq = court.tipSeq + 1;
  const staged = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    let receipt;
    try {
      if (op === null || typeof op !== "object" || Array.isArray(op)) {
        const err = new Error("op must be a plain object");
        err.code = "OP_MALFORMED";
        throw err;
      }
      receipt = makeReceipt(nextSeq + i, op, prev);
      applyOp(working, op);
    } catch (e) {
      const code = e.code === "OP_MALFORMED" ? "OP_MALFORMED" : e instanceof TypeError ? "OP_MALFORMED" : "OP_APPLY_FAILED";
      return {
        ok: false,
        phase: "prepare",
        failedOp: i,
        code,
        detail: `op ${i} (${safeOpType(op)}) refused against post-op state: ${e.message}`,
        appliedCount: i,
        errors: [{ opIndex: i, code, detail: e.message }],
      };
    }
    staged.push(receipt);
    prev = receipt.hash;
  }

  // Final gate: the post-op state must be canonicalizable (catches values with
  // no stable JSON meaning staged by an `init`/`set`).
  let toStateHash;
  try {
    toStateHash = cellsStateHash(working);
  } catch (e) {
    return {
      ok: false,
      phase: "prepare",
      failedOp: ops.length - 1,
      code: "STATE_UNSERIALIZABLE",
      detail: `staged post-op state has no canonical form: ${e.message}`,
      appliedCount: ops.length,
      errors: [{ opIndex: ops.length - 1, code: "STATE_UNSERIALIZABLE", detail: e.message }],
    };
  }

  // ---- COMMIT: materialize the successor bundle exactly once ---------------
  const successor = snapshot(working, [...baseReceipts, ...staged], {
    name: base.manifest.name,
    organId: base.manifest.organId,
    edges: base.manifest.edges,
    supersedes: base.manifest.manifestHash,
  });
  // v2 partial custody: the anchor and the seed ride forward — the successor
  // bundle stays bootable under the same checkpoint key.
  if (base.seed && base.checkpoint) {
    successor.seed = freezeJson(base.seed);
    successor.checkpoint = freezeJson(base.checkpoint);
  }
  const selfCheck = verifyBundle(successor, opts);
  if (!selfCheck.ok) {
    fail("REPLAY_DIVERGENCE", `transact produced a bundle that fails its own boot courtroom: ${selfCheck.errors.map((e) => `[${e.code}] ${e.detail}`).join(" | ")}`);
  }

  return {
    ok: true,
    unchanged: false,
    appliedCount: ops.length,
    bundle: successor,
    newReceipts: staged,
    fromStateHash,
    toStateHash,
  };
}

function safeOpType(op) {
  return op && typeof op === "object" && typeof op.type === "string" ? op.type : "?";
}
