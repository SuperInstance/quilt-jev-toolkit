// quilt-jev-toolkit — organ snapshot v0 (lane 63-c)
//
// snapshot(cells, ledger) → organ bundle { manifest, state, receipts }
//
// Spec (docs/REVERSE-ACTUALIZED-SPEC.md §2): a snapshot is a CUSTODY CLAIM —
// content-addressed (I1) over canonical state bytes + the sha256 receipt
// range that produced that state. The manifest is the claim document (I4);
// the bundle carries exactly the bytes needed to prove the claim to boot.

import {
  GENESIS,
  ORGAN_MANIFEST_SCHEMA,
  ORGAN_MANIFEST_VERSION,
  canonicalJson,
  computeManifestHash,
  mintOrganId,
  sha256Json,
  validateManifest,
} from "./manifest.mjs";

/** sha256 over one cell's canonical content. */
export function cellStateHash(cell) {
  return sha256Json({ kind: cell.kind, value: cell.value });
}

/** sha256 over the canonical whole-state bytes. */
export function cellsStateHash(cells) {
  return sha256Json(cells);
}

/** Deep-clone via canonical JSON round-trip (also refuses non-serializable state). */
export function freezeJson(value) {
  return JSON.parse(canonicalJson(value));
}

/**
 * Build an organ bundle.
 *
 * @param cells   plain object or Map of { cellId → { kind, value } }
 * @param ledger  array of hash-linked receipts (the organ's causal history)
 * @param opts    {
 *   name        required organ name (first snapshot)
 *   organId     optional — carry identity forward on re-snapshot
 *   cellIds     optional subset to include (default: all cells)
 *   edges       optional [{from,to}] data-flow edges (default [])
 *   supersedes  optional prior manifestHash for re-snapshots
 * }
 *
 * v0 custody rule: the bundle carries the FULL provided ledger from its
 * first receipt; if that first receipt is not seq 0 / GENESIS the manifest
 * pins it as a checkpoint requirement (boot must then be given that
 * checkpoint — CUSTODY_GAP otherwise).
 */
export function snapshot(cells, ledger, opts = {}) {
  if (typeof opts.name !== "string" || opts.name.length === 0) {
    throw new TypeError("snapshot: opts.name is required");
  }
  const cellMap = cells instanceof Map ? Object.fromEntries([...cells.entries()].map(([k, v]) => [k, v])) : cells;
  if (cellMap === null || typeof cellMap !== "object" || Array.isArray(cellMap)) {
    throw new TypeError("snapshot: cells must be a plain object or Map");
  }
  if (!Array.isArray(ledger)) throw new TypeError("snapshot: ledger must be an array of receipts");
  if (ledger.length === 0) throw new TypeError("snapshot: refusing an empty ledger (no custody = no organ)");

  // Canonical cell order: sorted ids, deduped — the manifest (and therefore
  // the manifestHash) is a pure function of content, never of caller order.
  const cellIds = [...new Set(opts.cellIds ?? Object.keys(cellMap))].sort();
  if (cellIds.length === 0) throw new TypeError("snapshot: cellIds resolved to an empty set");
  for (const id of cellIds) {
    if (!cellMap[id]) throw new TypeError(`snapshot: cell ${id} not present in cells`);
  }

  // Frozen (canonical, self-purifying) state + per-cell hashes.
  const stateCells = {};
  for (const id of cellIds) stateCells[id] = freezeJson(cellMap[id]);
  const state = { cells: stateCells };
  const cellsSha256 = cellsStateHash(stateCells);

  // Receipts carried verbatim (frozen). Chain must at least be contiguous
  // *internally*; full hash verification is boot's job — but snapshotting an
  // already-broken chain should fail here too (fail-closed at the earliest gate).
  const receipts = freezeJson(ledger);
  const first = receipts[0];
  const last = receipts[receipts.length - 1];
  const startSeq = first.seq;
  const genesisPrevHash = first.prev;

  const organId = opts.organId ?? mintOrganId(opts.name, { cellsSha256, tipHash: last.hash, startSeq, genesisPrevHash });

  const manifest = {
    schema: ORGAN_MANIFEST_SCHEMA,
    schemaVersion: ORGAN_MANIFEST_VERSION,
    organId,
    name: opts.name,
    cells: cellIds.map((id) => ({ id, kind: stateCells[id].kind, stateHash: cellStateHash(stateCells[id]) })),
    edges: freezeJson(opts.edges ?? []),
    receiptRange: { start: startSeq, end: last.seq, count: receipts.length },
    genesis: { seq: startSeq, prevHash: genesisPrevHash },
    state: { cellsSha256 },
    supersedes: opts.supersedes ?? null,
  };
  manifest.manifestHash = computeManifestHash(manifest);

  const validation = validateManifest(manifest);
  if (!validation.ok) {
    const err = new Error("snapshot: produced an invalid manifest (fail-closed)");
    err.code = "MANIFEST_INVALID";
    err.errors = validation.errors;
    throw err;
  }

  return { manifest, state, receipts };
}

/**
 * Re-snapshot a booted organ (or any quilt-like {cells, ledger, manifest?})
 * into a fresh portable bundle: same identity, full organ-local chain,
 * `supersedes` pinned to the prior manifestHash when known.
 */
export function snapshotOrgan(organ, opts = {}) {
  return snapshot(organ.cells, organ.ledger, {
    name: opts.name ?? organ.manifest.name,
    organId: opts.organId ?? organ.manifest.organId,
    edges: opts.edges ?? organ.manifest.edges,
    supersedes: opts.supersedes === false ? null : (organ.manifest?.manifestHash ?? null),
  });
}
