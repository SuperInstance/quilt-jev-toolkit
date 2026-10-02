// quilt-jev-toolkit — organ-side chrono-op adapter (wave-68, lane 68-a)
//
//   bootChrono({ links, checkpoint }, { key }) → booted organ
//   mapChronoChain(links)                      → { receipts, cells }
//
// This is the wave-67 queued glue, landed on the organ side: quilt-chrono's
// seal (src/seal.js) already emits a BYTE-EXACT quilt.organ.checkpoint over a
// hash-chain sidecar whose links are organ receipts whose `op` is the chrono
// entry verbatim. 67-a's hand-off note said an organ-side chrono-op adapter
// "would make snapshot+seal+sidecar a fully boot()-able organ bundle". This
// module is exactly that adapter. quilt-chrono stays READ-ONLY and standalone;
// every primitive used here is this repo's own (boot.mjs, manifest.mjs,
// snapshot.mjs) — equivalence with chrono's verifyCustody is a TEST, not an
// import (test/chrono-interop.test.mjs, skip-if-absent; the committed fixture
// keeps the suite green without the sibling).
//
// ---------------------------------------------------------------------------
// THE MAPPING (spec §9 — every decision has a named reason and a test)
// ---------------------------------------------------------------------------
//
// A chrono entry is { seq, ts_utc, op: "read"|"write", cell, value, by, cause,
// pushed, flow_id, edge, corrects }. The organ op vocabulary (toyQuilt.mjs) is
// { init, set, render } + the `organ.*` bookkeeping no-op envelope. The
// translation, entry by entry, 1:1 (link i → receipt i, seqs stay aligned):
//
//   read  → { type: "organ.chrono.read", cellId, witness, by, cause,
//             chrono: { seq, hash } }
//           R1. Organ law: cells change only through cell ops; chrono's own
//               cellsAt() agrees ("reads are observations, not transitions").
//               But the sidecar chain is SEALED 1:1 — a skipped entry would
//               desync the seq binding and silently drop ledger content — so
//               the read maps to a receipt that changes no cells. It rides the
//               `organ.*` no-op envelope (toyQuilt.applyOp already replays
//               those as pure bookkeeping) instead of growing the stand-in
//               substrate's op vocabulary for a foreign substrate. `witness`
//               keeps the observed value; the audit trail stays inline.
//   write, cell unborn → { type: "init", cellId, kind: "value", value, ... }
//           R2. Chrono cells are BORN on first write (engine:init writes are
//               births; push sinks are born by their first delivery). Organ
//               `set` refuses a nonexistent cell; `init` WITH the value is the
//               exact single-receipt birth. kind is "value" because a bare
//               chrono ledger proves only values (the seal manifest refuses
//               any other kind — chrono seal.js validateSealManifest).
//   write, cell born → { type: "set", cellId, value, ... }
//           R3. Direct correspondence; no invention needed.
//   push  → the pair: witness receipt + set/init receipt.
//           R4. A push is not an entry type: chrono's recordFlow() appends a
//               (read, write) PAIR sharing a flow_id (source read, sink write,
//               pushed=true). 1:1 entry mapping therefore carries the pair over
//               as (witness, set) automatically — and the pairing law is
//               ENFORCED in translation (CHRONO_FLOW_UNPAIRED), so a write
//               claiming a flow with no read is a hole in the causal fabric
//               and refuses, exactly as chrono's own ledger law says.
//
//   R5. Every mapped op carries `chrono: { seq, hash }` — the source link's
//       seq and receipt hash. The organ ledger becomes self-describing: every
//       receipt names the exact sealed chrono link it was translated from,
//       and the mapped receipt hash covers those binding bytes.
//   R6. Wall-clock does not cross. `ts_utc` stays in the sidecar, reachable
//       through the chrono pointer — organ law: "receipts carry no
//       wall-clock time; seq is time" (spec §2 I3). by/cause/pushed are
//       causal, not clock, so they ride along.
//   R7. Fail-closed on anything else: an op that is not "read"/"write", a
//       missing/empty cell, or a value with no canonical JSON form refuses
//       with CHRONO_OP_UNMAPPABLE — never coerced, never skipped.
//
// CUSTODY SHAPE (R8/R9): the mapped receipts form a NEW organ receipt chain
// anchored at GENESIS that replays to exactly the sealed manifest's state.
// When the seal sits at the chain tip, the SIGNED seal manifest is reused
// verbatim as the organ bundle manifest — the bytes the HMAC anchors are the
// bytes the organ boots. When the carried chain extends past the seal
// (post-seal appends are legal and chain-linked to the boundary), the tip
// bundle is re-snapshotted with the SAME organId and supersedes = the sealed
// manifestHash (identity carried, honest lineage). Either way the mapped
// bundle is FULL custody from GENESIS, and the real `boot()` runs the whole
// courtroom unmodified. The organ carries provenance
//   organ.custody = { kind: "chrono-seal", alg, signedAt, sealedRange,
//                     verifiedRange, chainTip }
// — honestly kinded "chrono-seal" (not "signed-checkpoint") because the
// signature vouches for the chrono SOURCE chain, not for a custody gap in the
// mapped bundle: nothing here is unsigned history.
//
// Fail-closed codes added by this adapter (all others are organ codes reused):
//   CHRONO_OP_UNMAPPABLE   — an entry the mapping refuses (R7)
//   CHRONO_FLOW_UNPAIRED   — a flow-tagged write with no read of that flow_id
// Everything else propagates from boot.mjs / manifest.mjs verbatim:
//   CHECKPOINT_SIGNATURE_REQUIRED / CHECKPOINT_MALFORMED /
//   CHECKPOINT_SIGNATURE_INVALID / CHECKPOINT_ANCHOR_MISMATCH /
//   CHECKPOINT_SEQ_BEYOND_RECEIPTS / CUSTODY_CHECKPOINT_MISMATCH /
//   CHAIN_GAP / RECEIPT_HASH_MISMATCH / REPLAY_DIVERGENCE / boot's own codes.

import {
  GENESIS,
  canonicalJson,
  computeManifestHash,
  makeReceipt,
  validateManifest,
  verifyChain,
} from "./manifest.mjs";
import { OrganBootError, boot, verifySignedCheckpoint } from "./boot.mjs";
import { cellsStateHash, snapshot } from "./snapshot.mjs";

/** The chrono entry verbs a bare ledger can carry (quilt-chrono ledger.js OPS). */
export const CHRONO_ENTRY_OPS = new Set(["read", "write"]);

/** The no-op envelope type a chrono read maps to (R1). `organ.*` ops are
 *  pointer receipts by toyQuilt law: they change no cells and replay as
 *  no-ops, so the FULL organ courtroom replays a translated chrono chain
 *  unmodified. */
export const CHRONO_READ_TYPE = "organ.chrono.read";

const fail = (code, detail) => {
  throw new OrganBootError(code, detail);
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Canonicalizable? (used fail-closed: an op whose bytes have no canonical
 *  form cannot enter an organ ledger). */
function canonicalOrThrow(value, code, detail) {
  try {
    return canonicalJson(value);
  } catch (e) {
    fail(code, `${detail}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// the mapping — chrono entry (+ its link) → organ op
// ---------------------------------------------------------------------------

/** R1 — a read becomes a no-op witness receipt op. */
function chronoReadOp(entry, ref) {
  return {
    type: CHRONO_READ_TYPE,
    cellId: entry.cell,
    witness: entry.value,
    by: entry.by,
    cause: entry.cause,
    chrono: ref,
  };
}

/**
 * BRIDGE: the sealed sidecar links → a full-custody organ receipt chain.
 *
 * Walks the links once, deterministically:
 *  - every link maps to exactly ONE receipt at the SAME seq (1:1 — reads and
 *    writes each map to one receipt; a push is two entries, so it is two
 *    links, and maps to the (witness, set) pair of receipts);
 *  - receipts are hash-linked from GENESIS (makeReceipt law: the hash covers
 *    {seq, op, prev}, and op embeds the source link hash — R5);
 *  - the walk also folds the state (the same fold the replay will do), so the
 *    caller gets the tip cells as a byproduct.
 *
 * Fail-closed: the first unmappable entry refuses the whole bridge.
 *
 * @returns { receipts, cells } — organ receipts + the tip state they replay to.
 */
export function mapChronoChain(links) {
  if (!Array.isArray(links) || links.length === 0) {
    fail("CHAIN_GAP", "chrono sidecar links is empty or not an array — no custody");
  }

  // pre-scan: flow_ids that carry at least one read anywhere (the pairing law
  // is "paired with >= 1 read", not "preceded by" — chrono appends read-then-
  // write, but the law as written is order-independent; we enforce the law).
  const flowReads = new Set();
  for (const link of links) {
    const e = link?.op;
    if (isPlainObject(e) && e.op === "read" && e.flow_id !== null && e.flow_id !== undefined) {
      flowReads.add(e.flow_id);
    }
  }

  const receipts = [];
  const bornCells = new Set();
  let prev = GENESIS;

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!isPlainObject(link) || link.seq !== i) {
      fail("CHAIN_GAP", `sidecar link at index ${i} is not an object or its seq is not ${i} — the sidecar is a contiguous organ receipt chain`);
    }
    const entry = isPlainObject(link.op) ? link.op : null;
    if (!entry) fail("CHRONO_OP_UNMAPPABLE", `sidecar link at seq ${i} carries no chrono entry object`);
    const ref = { seq: i, hash: link.hash };
    if (entry.seq !== i) {
      fail("CHRONO_OP_UNMAPPABLE", `entry seq ${JSON.stringify(entry.seq)} disagrees with its sidecar link seq ${i} — a link's op IS the entry verbatim`);
    }
    if (!CHRONO_ENTRY_OPS.has(entry.op)) {
      fail("CHRONO_OP_UNMAPPABLE", `chrono op ${JSON.stringify(entry.op)} at seq ${i} is not in ${[...CHRONO_ENTRY_OPS].join("/")} — unmappable, refusing (R7)`);
    }
    if (typeof entry.cell !== "string" || entry.cell.length === 0) {
      fail("CHRONO_OP_UNMAPPABLE", `chrono entry at seq ${i} has no cell — neither a witness nor a transition can be named`);
    }

    let op;
    if (entry.op === "read") {
      op = chronoReadOp(entry, ref); // R1
    } else {
      // R4: the causal-fabric law crosses the boundary with the write.
      if (entry.flow_id !== null && entry.flow_id !== undefined && !flowReads.has(entry.flow_id)) {
        fail("CHRONO_FLOW_UNPAIRED", `write at seq ${i} claims flow_id ${JSON.stringify(entry.flow_id)} but no read of that flow exists — a write without a cause-read is a hole in the causal fabric (chrono ledger law, enforced in translation)`);
      }
      // R2/R3: born-cell decision is made against the walk's own state — the
      // same order the replay will apply, so walk and replay cannot disagree.
      const base = { cellId: entry.cell, value: entry.value, by: entry.by, cause: entry.cause, chrono: ref };
      op = bornCells.has(entry.cell) ? { type: "set", ...base } : { type: "init", kind: "value", ...base };
      bornCells.add(entry.cell);
    }

    // R7 fail-closed: an op with no canonical bytes cannot enter the ledger
    // (catches undefined values on reads AND writes — a bare ledger entry is
    // JSON by construction; refusing to invent values).
    canonicalOrThrow(op, "CHRONO_OP_UNMAPPABLE", `mapped op at seq ${i} has no canonical form`);

    const receipt = makeReceipt(i, op, prev);
    receipts.push(receipt);
    prev = receipt.hash;
  }

  // state fold: reuse the MAPPED receipts (not the raw entries), so the
  // bridge's fold IS the organ replay by construction — a mapping bug cannot
  // hide behind a divergent private fold (boot() re-proves with toyQuilt.applyOp).
  const cells = {};
  for (const r of receipts) applyMappedOp(cells, r.op);

  return { receipts, cells };
}

/** Apply one MAPPED op to a cells object — the toy evaluator's exact init/set
 *  semantics, plus the no-op envelope. Kept local so the bridge fold and the
 *  courtroom replay agree by construction (applyOp itself is not imported to
 *  avoid a second failure-message vocabulary; the equivalence of this fold
 *  with toyQuilt.applyOp is asserted by the boot replay in bootChrono). */
function applyMappedOp(cells, op) {
  if (op.type === CHRONO_READ_TYPE) return undefined; // witness receipt — no transition (R1)
  if (op.type === "init") {
    if (Object.prototype.hasOwnProperty.call(cells, op.cellId)) {
      fail("CHRONO_OP_UNMAPPABLE", `init: cell ${op.cellId} already born at mapping time — the walk and the replay disagree (adapter bug, fail-closed)`);
    }
    cells[op.cellId] = { kind: op.kind, value: op.value };
    return cells[op.cellId];
  }
  if (op.type === "set") {
    const cell = cells[op.cellId];
    if (!cell) fail("CHRONO_OP_UNMAPPABLE", `set: cell ${op.cellId} never born at mapping time — the walk and the replay disagree (adapter bug, fail-closed)`);
    cell.value = op.value;
    return cell;
  }
  return fail("CHRONO_OP_UNMAPPABLE", `mapped op type ${JSON.stringify(op.type)} is not a chrono product (adapter bug, fail-closed)`);
}

// ---------------------------------------------------------------------------
// bootChrono — the courtroom for a sealed chrono bundle
// ---------------------------------------------------------------------------

/**
 * Boot a TIME-TRAVELING SHEET: a quilt-chrono ledger (sealed) becomes a live
 * organ inside the organ protocol.
 *
 * @param bundle { links, checkpoint }
 *   links      the chain sidecar links — organ receipts whose op is the chrono
 *              entry verbatim ({seq, op, prev, hash}, GENESIS-anchored). This
 *              is `<ledger>.chain.jsonl` in quilt-chrono.
 *   checkpoint the seal — a BYTE-EXACT quilt.organ.checkpoint v1 (HMAC-SHA256
 *              over {hash, manifestHash, seq}, carrying the prefix manifest).
 * @param opts { key } — the HMAC key the seal must verify under (REQUIRED:
 *              an unsigned seal is refused; CHECKPOINT_SIGNATURE_REQUIRED).
 *
 * Courtroom, in order (fail-closed, named codes, no partial success):
 *   1. shape                                  → CHAIN_GAP / CHECKPOINT_MALFORMED
 *   2. verifySignedCheckpoint (boot.mjs law)  → CHECKPOINT_SIGNATURE_REQUIRED /
 *                                               CHECKPOINT_MALFORMED /
 *                                               CHECKPOINT_SIGNATURE_INVALID
 *   3. the seal's manifest re-hashes to the SIGNED manifestHash and is a
 *      full-prefix manifest [0..seq]          → CHECKPOINT_ANCHOR_MISMATCH
 *   4. the links re-verify as an organ chain  → CHAIN_GAP / RECEIPT_HASH_MISMATCH
 *   5. the seal pins THIS chain's boundary    → CHECKPOINT_SEQ_BEYOND_RECEIPTS
 *                                               (truncated bundle) /
 *                                               CUSTODY_CHECKPOINT_MISMATCH
 *   6. the mapping (spec §9)                  → CHRONO_OP_UNMAPPABLE /
 *                                               CHRONO_FLOW_UNPAIRED
 *   7. mapped replay at the boundary == the SIGNED manifest's state
 *                                             → REPLAY_DIVERGENCE
 *   8. the real boot() runs the whole organ courtroom on the mapped bundle
 *      (manifest, state hash, chain, replay == state) — nothing is trusted
 *      from steps 1-7 except the right to build the bundle.
 *
 * @returns the booted organ (organ.cells = the sheet state at the tip; the
 *   ledger is the mapped organ receipt chain; organ.custody = chrono-seal
 *   provenance; organ.append continues the chain with organ-native ops).
 */
export function bootChrono(bundle, opts = {}) {
  if (!isPlainObject(bundle)) fail("CHAIN_GAP", "bootChrono: bundle is not an object");
  const { links, checkpoint } = bundle;
  if (!Array.isArray(links) || links.length === 0) {
    fail("CHAIN_GAP", "bootChrono: bundle.links is empty or not an array — the chain sidecar IS the custody; entries without links are unchained");
  }
  if (!isPlainObject(checkpoint)) fail("CHECKPOINT_MALFORMED", "bootChrono: bundle.checkpoint is not an object");

  // 2. the signature itself (structure + HMAC under the verifier's key)
  const sig = verifySignedCheckpoint(checkpoint, opts.key);
  if (!sig.ok) fail(sig.code, sig.detail);

  // 3. the anchor manifest: unsigned, but content-addressed to the SIGNED
  //    manifestHash — the organ 4d law (boot.mjs), applied to the chrono seal.
  const manifest = checkpoint.manifest;
  const mv = validateManifest(manifest);
  if (!mv.ok || computeManifestHash(manifest) !== checkpoint.manifestHash
      || manifest.receiptRange.start !== 0
      || manifest.receiptRange.end !== checkpoint.seq
      || manifest.receiptRange.count !== checkpoint.seq + 1
      || manifest.genesis.seq !== 0
      || manifest.genesis.prevHash !== GENESIS) {
    fail("CHECKPOINT_ANCHOR_MISMATCH", `the seal's prefix manifest does not re-hash to the signed manifestHash ${checkpoint.manifestHash} (or is not a full-prefix manifest [0..${checkpoint.seq}]) — swapped or tampered anchor`);
  }

  // 4. the sidecar IS an organ receipt chain (67-a proved the byte-formula
  //    identity; here it is verified, not assumed).
  const cv = verifyChain(links, { expectedStart: 0, expectedPrev: GENESIS });
  if (!cv.ok) fail(cv.code, `chrono sidecar fails organ chain verify: ${cv.detail}`);

  // 5. the seal must pin THIS chain's boundary.
  const tipSeq = links[links.length - 1].seq;
  if (checkpoint.seq > tipSeq) {
    fail("CHECKPOINT_SEQ_BEYOND_RECEIPTS", `seal anchors seq ${checkpoint.seq} but the carried sidecar ends at seq ${tipSeq} — the bundle is truncated below its own custody boundary`);
  }
  if (links[checkpoint.seq].hash !== checkpoint.hash) {
    fail("CUSTODY_CHECKPOINT_MISMATCH", `seal pins hash ${checkpoint.hash} at seq ${checkpoint.seq}, but the carried chain's link there hashes to ${links[checkpoint.seq].hash} — wrong chain or wrong boundary`);
  }

  // 6. the mapping (spec §9) — fail-closed on anything unmappable.
  const { receipts, cells } = mapChronoChain(links);

  // 7. the mapped replay at the boundary must reproduce the SIGNED state —
  //    the state-equality assertion that makes the translation custody-bearing.
  let boundaryCells = {};
  for (let i = 0; i <= checkpoint.seq; i++) applyMappedOp(boundaryCells, receipts[i].op);
  const boundaryHash = cellsStateHash(boundaryCells); // throws TypeError on non-canonical — impossible post step 6
  if (boundaryHash !== manifest.state.cellsSha256) {
    fail("REPLAY_DIVERGENCE", `mapped replay at the sealed boundary produces ${boundaryHash}, the signed manifest claims ${manifest.state.cellsSha256} — the mapping does not reproduce the sealed state (refusing; the sidecar and seal verified, so this is an adapter-law violation)`);
  }

  // 8. build the organ bundle and hand it to the REAL courtroom.
  let organBundle;
  if (tipSeq === checkpoint.seq) {
    // R8: the seal sits at the tip — the SIGNED manifest IS the organ
    // manifest; the bytes the HMAC anchors are the bytes the organ boots.
    organBundle = { manifest, state: { cells }, receipts };
  } else {
    // R10: post-seal appends are carried (chain-linked to the boundary; any
    // tamper breaks the chain at a named seq). The tip bundle is re-snapshotted
    // with the SAME organId and honest lineage back to the signed manifest.
    organBundle = snapshot(cells, receipts, {
      name: manifest.name,
      organId: manifest.organId,
      edges: [],
      supersedes: manifest.manifestHash,
    });
  }

  const organ = boot(organBundle); // full custody from GENESIS — boot re-proves everything

  // R9: chrono-seal provenance (honestly kinded — see module header).
  organ.custody = {
    kind: "chrono-seal",
    alg: checkpoint.alg,
    signedAt: { seq: checkpoint.seq, hash: checkpoint.hash, manifestHash: checkpoint.manifestHash },
    sealedRange: { start: 0, end: checkpoint.seq },
    verifiedRange: { start: 0, end: tipSeq },
    chainTip: links[links.length - 1].hash,
  };
  return organ;
}

/** Convenience: the sheet state a sealed bundle would boot to, without
 *  booting (pure; the courtroom still runs — this is bootChrono minus the
 *  organ construction). Useful for previews and diffing. */
export function chronoStateAtTip(bundle, opts = {}) {
  if (!isPlainObject(bundle) || !Array.isArray(bundle.links) || bundle.links.length === 0) {
    fail("CHAIN_GAP", "chronoStateAtTip: bundle.links is empty or not an array");
  }
  const cv = verifyChain(bundle.links, { expectedStart: 0, expectedPrev: GENESIS });
  if (!cv.ok) fail(cv.code, `chrono sidecar fails organ chain verify: ${cv.detail}`);
  return mapChronoChain(bundle.links).cells;
}
