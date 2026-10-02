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
 * v1 (lane 64-a), rewind-aware: an organ that has been rewound (see
 * rewind.mjs) carries an `organ.rewind` receipt in the host ledger that
 * REVOKES the host credits for the rewound window — the double-entry
 * discipline applied backwards. The audit therefore treats a credit as live
 * unless some organ.rewind receipt (same organId) LISTS it in its rewound[]
 * evidence (credits minted after the rewind are never listed, so they stay
 * live), and it self-audits each rewind receipt: its toSeq must sit inside
 * the organ's carried range, its stateHashAfter must equal the organ's
 * replayed state at toSeq, and every rewound[] entry must match a real host
 * credit. Nothing is ever erased: revoked credits stay in the host ledger,
 * marked dead by the compensating receipt.
 *
 * @param host        host quilt (its own chain is verified first)
 * @param organ       booted organ { organId, ledger, cells, nestReceipt }
 * @returns { ok, errors, creditsChecked, creditsRevoked, rewinds }
 */
export function verifyDoubleEntry(host, organ) {
  const errors = [];
  const hv = verifyChain(host.ledger, { expectedStart: 0, expectedPrev: "GENESIS", allowEmpty: true });
  if (!hv.ok) errors.push({ code: hv.code, detail: `host chain broken: ${hv.detail}` });

  const nestSeq = organ.nestReceipt?.op?.organSeq;
  if (!Number.isInteger(nestSeq)) {
    errors.push({ code: "DOUBLE_ENTRY_UNBALANCED", detail: "organ has no valid nest receipt (not nested?)" });
    return { ok: false, errors, creditsChecked: 0, creditsRevoked: 0, rewinds: 0 };
  }

  const credits = host.ledger.filter((r) => r.op?.type === "organ.credit" && r.op.organId === organ.organId);
  const organRewinds = host.ledger.filter((r) => r.op?.type === "organ.rewind" && r.op.organId === organ.organId);
  const debits = organ.ledger.filter((r) => r.seq > nestSeq);

  // Replay the organ ledger once, capturing the state hash after each receipt.
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
      return { ok: false, errors, creditsChecked: 0, creditsRevoked: 0, rewinds: organRewinds.length };
    }
  }
  const carriedSeqs = new Set(organ.ledger.map((r) => r.seq));
  const creditBySeq = new Map(credits.map((c) => [c.seq, c]));

  // -- v1: self-audit every organ.rewind receipt (the compensating entries) --
  // Revocation is EVIDENCE-BASED: a credit is dead exactly when some rewind
  // receipt lists it in rewound[]. Credits created AFTER a rewind (the organ
  // continues appending from the rewound tip) are never listed, so they stay
  // live and pair with their fresh debits. An incomplete or padded evidence
  // list cannot cheat the audit: the live-credit vs live-debit pairing below
  // is the ground truth.
  const revokedCreditSeqs = new Set();
  for (const R of organRewinds) {
    const to = R.op.toSeq;
    if (!Number.isInteger(to) || !carriedSeqs.has(to)) {
      errors.push({
        code: "DOUBLE_ENTRY_REWIND_INVALID",
        detail: `organ.rewind at host seq ${R.seq}: toSeq ${JSON.stringify(to)} is not a seq the organ's carried ledger contains`,
      });
    }
    if (Number.isInteger(to) && stateAtSeq.get(to) !== R.op.stateHashAfter) {
      errors.push({
        code: "DOUBLE_ENTRY_STATE_MISMATCH",
        detail: `organ.rewind at host seq ${R.seq}: stateHashAfter ${R.op.stateHashAfter} != organ replay at seq ${to} (${stateAtSeq.get(to)})`,
      });
    }
    if (!Array.isArray(R.op.rewound)) {
      errors.push({ code: "DOUBLE_ENTRY_REWIND_INVALID", detail: `organ.rewind at host seq ${R.seq} carries no rewound[] evidence list` });
      continue;
    }
    const listed = new Set();
    for (const w of R.op.rewound) {
      // temporal form: an honest rewinder lists only credits that ALREADY
      // existed (host seq below the rewind receipt) — a credit minted after
      // the rewind belongs to the organ's continued life and is unrevokable
      if (!Number.isInteger(w.creditSeq) || w.creditSeq >= R.seq) {
        errors.push({
          code: "DOUBLE_ENTRY_REWIND_INVALID",
          detail: `organ.rewind at host seq ${R.seq} lists credit seq ${JSON.stringify(w.creditSeq)}, which does not precede the rewind receipt — later credits are unrevokable by it`,
        });
      }
      if (listed.has(w.creditSeq)) {
        errors.push({ code: "DOUBLE_ENTRY_REWIND_INVALID", detail: `organ.rewind at host seq ${R.seq} lists credit seq ${JSON.stringify(w.creditSeq)} twice` });
      }
      listed.add(w.creditSeq);
      revokedCreditSeqs.add(w.creditSeq);
      const c = creditBySeq.get(w.creditSeq);
      if (!c || c.hash !== w.creditHash || c.op.organSeq !== w.organSeq || c.op.debitHash !== w.debitHash) {
        errors.push({
          code: "DOUBLE_ENTRY_HASH_MISMATCH",
          detail: `organ.rewind at host seq ${R.seq} lists credit seq ${JSON.stringify(w.creditSeq)}, which the host ledger does not carry with those hashes`,
        });
      }
    }
  }

  const liveCredits = credits.filter((c) => !revokedCreditSeqs.has(c.seq));
  const deadCredits = credits.length - liveCredits.length;

  // v1 pairing law (rewind-aware): a LIVE credit must resolve to an organ
  // debit the organ's CURRENT carried ledger actually holds (same seq, same
  // debitHash) — after a rewind the organ keeps appending from the rewound
  // tip, so "after nest" is no longer a pure seq-window test on the credit
  // side. The requirement direction stays: every carried post-nest debit
  // (seq > nestSeq) must be covered by a live credit; a debit whose credit was
  // robbed shows up as a host CHAIN_GAP first (append-only ledger), and a
  // credit robbed of its debit shows up here.
  const debitBySeq = new Map(organ.ledger.map((d) => [d.seq, d]));
  const covered = new Set();
  for (const c of liveCredits) {
    const d = debitBySeq.get(c.op.organSeq);
    if (!d || d.hash !== c.op.debitHash) {
      errors.push({ code: "DOUBLE_ENTRY_HASH_MISMATCH", detail: `credit at host seq ${c.seq} points at organSeq ${c.op.organSeq}, which is not a debit the organ's carried ledger holds with that hash` });
      continue;
    }
    covered.add(c.op.organSeq);
    if (stateAtSeq.get(d.seq) !== c.op.stateHashAfter) {
      errors.push({ code: "DOUBLE_ENTRY_STATE_MISMATCH", detail: `credit at host seq ${c.seq}: stateHashAfter ${c.op.stateHashAfter} != replayed organ state hash ${stateAtSeq.get(d.seq)}` });
    }
  }
  const uncovered = debits.filter((d) => !covered.has(d.seq));
  if (uncovered.length > 0) {
    errors.push({
      code: "DOUBLE_ENTRY_UNBALANCED",
      detail: `${uncovered.length} carried post-nest debit(s) [seq ${uncovered.map((d) => d.seq).join(", ")}] without a live host credit (${deadCredits} credit(s) revoked by rewind)`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    creditsChecked: liveCredits.length,
    creditsRevoked: deadCredits,
    rewinds: organRewinds.length,
  };
}
