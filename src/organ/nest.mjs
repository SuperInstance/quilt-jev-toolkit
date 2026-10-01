// quilt-jev-toolkit — organ nesting envelope v0 (lane 63-c)
//
// The envelope law (docs/REVERSE-ACTUALIZED-SPEC.md §5):
//   - an organ's ledger is ITS OWN hash chain; nesting never merges chains —
//     an organ that lived in quilt A and now lives in quilt B keeps one
//     unbroken causal ledger across the quilt boundary
//   - the host receives pure pointer receipts (credits): every organ debit
//     after nesting gets exactly one host credit, double-entry style
//   - host invariants stay structurally safe because the host chain only ever
//     appends well-formed host receipts
//
// Debit  = receipt in the organ's own ledger (state transition on organ cells)
// Credit = receipt in the host ledger { organId, organSeq, debitHash,
//          stateHashAfter } — a pointer + attestation, touches no host cells.

import { makeReceipt, verifyChain } from "./manifest.mjs";
import { applyOp as applyForNest } from "./toyQuilt.mjs";
import { cellsStateHash } from "./snapshot.mjs";

export class NestError extends Error {
  constructor(code, detail) {
    super(`[${code}] ${detail}`);
    this.name = "NestError";
    this.code = code;
    this.detail = detail;
  }
}

/** Append a bookkeeping receipt to a host ledger WITHOUT touching host cells
 *  (credits and nest markers are pointers, not state). Organ.* receipts are
 *  replayable as no-ops, so a host ledger including them still replays
 *  deterministically to the host's own cells. */
export function appendHostReceipt(host, op) {
  const last = host.ledger.length === 0 ? null : host.ledger[host.ledger.length - 1];
  const receipt = makeReceipt(last ? last.seq + 1 : 0, op, last ? last.hash : "GENESIS");
  host.ledger.push(receipt);
  return receipt;
}

/** Register a booted organ into a host quilt. Fail-closed on a broken host
 *  chain or a duplicate nest of the same manifest. */
export function nestInto(host, bundle, organ) {
  const hv = verifyChain(host.ledger, { expectedStart: 0, expectedPrev: "GENESIS", allowEmpty: true });
  if (!hv.ok) {
    throw new NestError(hv.code, `host ledger is not a valid chain: ${hv.detail}`);
  }
  for (const r of host.ledger) {
    if (r.op?.type === "organ.nest" && r.op.organId === organ.organId && r.op.manifestHash === bundle.manifest.manifestHash) {
      throw new NestError("DUPLICATE_NEST", `manifest ${bundle.manifest.manifestHash} of ${organ.organId} is already nested in this host`);
    }
  }
  const lastCarried = organ.ledger[organ.ledger.length - 1];
  const nestReceipt = appendHostReceipt(host, {
    type: "organ.nest",
    organId: organ.organId,
    manifestHash: bundle.manifest.manifestHash,
    tipHash: lastCarried.hash,
    organSeq: lastCarried.seq,
  });
  organ.host = host;
  organ.nestReceipt = nestReceipt;
  return nestReceipt;
}

/** Write the host-side CREDIT for an organ DEBIT (called by organ.append). */
export function appendCredit(host, { organId, organSeq, debitHash, stateHashAfter }) {
  return appendHostReceipt(host, {
    type: "organ.credit",
    organId,
    organSeq,
    debitHash,
    stateHashAfter,
  });
}

/**
 * Double-entry audit: every organ debit after the nest marker has exactly one
 * host credit, hashes pair 1:1, and each credit's stateHashAfter equals the
 * organ's replayed state at that organSeq.
 *
 * @param host        host quilt (its own chain is verified first)
 * @param organ       booted organ { organId, ledger, cells, nestReceipt }
 * @returns { ok, errors, creditsChecked }
 */
export function verifyDoubleEntry(host, organ) {
  const errors = [];
  const hv = verifyChain(host.ledger, { expectedStart: 0, expectedPrev: "GENESIS", allowEmpty: true });
  if (!hv.ok) errors.push({ code: hv.code, detail: `host chain broken: ${hv.detail}` });

  const nestSeq = organ.nestReceipt?.op?.organSeq;
  if (!Number.isInteger(nestSeq)) {
    errors.push({ code: "DOUBLE_ENTRY_UNBALANCED", detail: "organ has no valid nest receipt (not nested?)" });
    return { ok: false, errors, creditsChecked: 0 };
  }

  const credits = host.ledger.filter((r) => r.op?.type === "organ.credit" && r.op.organId === organ.organId);
  const debits = organ.ledger.filter((r) => r.seq > nestSeq);

  if (credits.length !== debits.length) {
    errors.push({
      code: "DOUBLE_ENTRY_UNBALANCED",
      detail: `${debits.length} organ debits after nest but ${credits.length} host credits`,
    });
  }

  // Replay the organ ledger once, capturing the state hash after each debit.
  const stateAtSeq = new Map();
  const replayed = {};
  for (const r of organ.ledger) {
    try {
      // Re-apply through the deterministic evaluator (toyQuilt.applyOp) —
      // imported lazily via cells mutation below to avoid an import cycle.
      applyForNest(replayed, r.op);
      stateAtSeq.set(r.seq, cellsStateHash(replayed));
    } catch (e) {
      errors.push({ code: "REPLAY_INVALID_OP", detail: `organ ledger replay failed at seq ${r.seq}: ${e.message}` });
      return { ok: false, errors, creditsChecked: 0 };
    }
  }

  const debitBySeq = new Map(debits.map((d) => [d.seq, d]));
  for (const c of credits) {
    const d = debitBySeq.get(c.op.organSeq);
    if (!d) {
      errors.push({ code: "DOUBLE_ENTRY_HASH_MISMATCH", detail: `credit at host seq ${c.seq} points at organSeq ${c.op.organSeq}, which is not a post-nest debit` });
      continue;
    }
    if (d.hash !== c.op.debitHash) {
      errors.push({ code: "DOUBLE_ENTRY_HASH_MISMATCH", detail: `credit at host seq ${c.seq}: debitHash ${c.op.debitHash} != organ debit hash ${d.hash}` });
    }
    if (stateAtSeq.get(d.seq) !== c.op.stateHashAfter) {
      errors.push({ code: "DOUBLE_ENTRY_STATE_MISMATCH", detail: `credit at host seq ${c.seq}: stateHashAfter ${c.op.stateHashAfter} != replayed organ state hash ${stateAtSeq.get(d.seq)}` });
    }
  }

  return { ok: errors.length === 0, errors, creditsChecked: credits.length };
}
