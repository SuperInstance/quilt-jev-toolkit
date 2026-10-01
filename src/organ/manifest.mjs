// quilt-jev-toolkit — organ manifest v0 (lane 63-c)
//
// The custody primitives: canonical JSON, sha256 content addressing,
// hash-linked receipts, chain verification, and the organ manifest
// schema `quilt.organ.manifest/v1`.
//
// Invariants (docs/REVERSE-ACTUALIZED-SPEC.md §2):
//   I1  content-addressed snapshots (canonical bytes + sha256)
//   I2  chain-of-custody from GENESIS or a pinned trusted checkpoint
//   I4  the manifest is the single portable custody claim
//
// No external deps. ESM. Determinism law: `seq` is time; receipts carry
// no wall-clock timestamps; all JSON is canonicalized (sorted keys).

import { createHash } from "node:crypto";

export const ORGAN_MANIFEST_SCHEMA = "quilt.organ.manifest";
export const ORGAN_MANIFEST_VERSION = 1;
export const GENESIS = "GENESIS";

// ---------------------------------------------------------------------------
// canonical JSON + sha256
// ---------------------------------------------------------------------------

/** Deterministic JSON: recursively sorted object keys, no whitespace.
 *  Refuses (throws) on values with no stable JSON meaning: undefined,
 *  functions, symbols, NaN/Infinity — fail-closed against silent coercion. */
export function canonicalJson(value, _path = "$") {
  if (value === undefined) {
    throw new TypeError(`canonicalJson: undefined at ${_path} (fail-closed; JSON has no stable meaning for undefined)`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${_path}`);
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new TypeError(`canonicalJson: bigint at ${_path} (v0 refuses; serialize explicitly as string)`);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`canonicalJson: ${typeof value} at ${_path} is not serializable (fail-closed)`);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v, i) => canonicalJson(v, `${_path}[${i}]`)).join(",") + "]";
  }
  if (value instanceof Map) {
    return canonicalJson(Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), v])), `${_path}#map`);
  }
  if (value instanceof Set) {
    return canonicalJson([...value.values()], `${_path}#set`);
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k], `${_path}.${k}`)).join(",") + "}";
}

export function sha256(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

export function sha256Json(value) {
  return sha256(canonicalJson(value));
}

const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// receipts — the double-entry book-keeping atom
// ---------------------------------------------------------------------------

/** Build one receipt: { seq, op, prev, hash }. `hash` covers {seq, op, prev}. */
export function makeReceipt(seq, op, prevHash) {
  if (!Number.isInteger(seq) || seq < 0) throw new TypeError(`makeReceipt: seq must be a non-negative integer, got ${seq}`);
  if (op === null || typeof op !== "object" || Array.isArray(op)) throw new TypeError("makeReceipt: op must be a plain object");
  if (typeof op.type !== "string" || op.type.length === 0) throw new TypeError("makeReceipt: op.type must be a non-empty string");
  const core = { seq, op, prev: prevHash };
  return { seq, op, prev: prevHash, hash: sha256(canonicalJson(core)) };
}

/** Recompute a receipt's content hash from its own fields. */
export function receiptHash(receipt) {
  return sha256(canonicalJson({ seq: receipt.seq, op: receipt.op, prev: receipt.prev }));
}

/** Verify a contiguous, hash-linked receipt chain.
 *  opts: { expectedStart, expectedPrev, allowEmpty }  (defaults: 0, GENESIS, false)
 *  Returns { ok, code?, detail?, tipHash, count } — ok:false is fail-closed upstream. */
export function verifyChain(receipts, opts = {}) {
  const expectedStart = opts.expectedStart ?? 0;
  let expectedPrev = opts.expectedPrev ?? GENESIS;
  if (!Array.isArray(receipts) || receipts.length === 0) {
    if (opts.allowEmpty && Array.isArray(receipts) && receipts.length === 0) {
      return { ok: true, tipHash: expectedPrev, count: 0 }; // a fresh ledger is a valid chain
    }
    return { ok: false, code: "CHAIN_GAP", detail: "empty receipt chain", tipHash: expectedPrev, count: 0 };
  }
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (!r || typeof r !== "object") return { ok: false, code: "CHAIN_GAP", detail: `receipt #${i} is not an object`, tipHash: expectedPrev, count: i };
    if (r.seq !== expectedStart + i) {
      return { ok: false, code: "CHAIN_GAP", detail: `seq discontinuity at index ${i}: expected ${expectedStart + i}, got ${r.seq}`, tipHash: expectedPrev, count: i };
    }
    if (r.prev !== expectedPrev) {
      return { ok: false, code: "CHAIN_GAP", detail: `prev-hash break at seq ${r.seq}: expected ${expectedPrev}, got ${r.prev}`, tipHash: expectedPrev, count: i };
    }
    const recomputed = receiptHash(r);
    if (recomputed !== r.hash) {
      return { ok: false, code: "RECEIPT_HASH_MISMATCH", detail: `hash mismatch at seq ${r.seq}: recomputed ${recomputed}, carried ${r.hash}`, tipHash: expectedPrev, count: i };
    }
    expectedPrev = r.hash;
  }
  return { ok: true, tipHash: expectedPrev, count: receipts.length };
}

// ---------------------------------------------------------------------------
// organ manifest — quilt.organ.manifest/v1
// ---------------------------------------------------------------------------

/** Hash of a manifest = sha256 of its canonical form *without* manifestHash. */
export function computeManifestHash(manifest) {
  const { manifestHash: _ignored, ...rest } = manifest;
  return sha256Json(rest);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Validate an organ manifest. Returns { ok, errors:[{code,detail}] }.
 *  Codes: SCHEMA_DRIFT, MANIFEST_INVALID. */
export function validateManifest(manifest) {
  const errors = [];
  const bad = (detail) => errors.push({ code: "MANIFEST_INVALID", detail });

  if (!isPlainObject(manifest)) return { ok: false, errors: [{ code: "MANIFEST_INVALID", detail: "manifest is not an object" }] };
  if (manifest.schema !== ORGAN_MANIFEST_SCHEMA) {
    errors.push({ code: "SCHEMA_DRIFT", detail: `schema ${JSON.stringify(manifest.schema)} !== ${ORGAN_MANIFEST_SCHEMA}` });
  }
  if (manifest.schemaVersion !== ORGAN_MANIFEST_VERSION) {
    errors.push({ code: "SCHEMA_DRIFT", detail: `schemaVersion ${JSON.stringify(manifest.schemaVersion)} not implemented (v0 knows only ${ORGAN_MANIFEST_VERSION})` });
  }
  if (errors.some((e) => e.code === "SCHEMA_DRIFT")) {
    return { ok: false, errors }; // drift: refuse before interpreting fields
  }

  if (typeof manifest.organId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}@[0-9a-f]{16}$/.test(manifest.organId)) {
    bad(`organId must match name@16hex, got ${JSON.stringify(manifest.organId)}`);
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) bad("name must be a non-empty string");

  const cells = manifest.cells;
  if (!Array.isArray(cells) || cells.length === 0) {
    bad("cells must be a non-empty array");
  } else {
    const ids = new Set();
    for (const c of cells) {
      if (!isPlainObject(c) || typeof c.id !== "string" || c.id.length === 0) { bad("cell entry missing id"); continue; }
      if (ids.has(c.id)) bad(`duplicate cell id ${c.id}`);
      ids.add(c.id);
      if (typeof c.kind !== "string" || c.kind.length === 0) bad(`cell ${c.id} missing kind`);
      if (typeof c.stateHash !== "string" || !HEX64.test(c.stateHash)) bad(`cell ${c.id} stateHash not sha256 hex`);
    }
    const edges = manifest.edges;
    if (!Array.isArray(edges)) bad("edges must be an array");
    else for (const e of edges) {
      if (!isPlainObject(e) || typeof e.from !== "string" || typeof e.to !== "string") bad("edge must be {from,to}");
      else {
        if (!ids.has(e.from)) bad(`edge.from ${e.from} is not a known cell`);
        if (!ids.has(e.to)) bad(`edge.to ${e.to} is not a known cell`);
      }
    }
  }

  const rr = manifest.receiptRange;
  if (!isPlainObject(rr) || !Number.isInteger(rr.start) || !Number.isInteger(rr.end) || !Number.isInteger(rr.count)) {
    bad("receiptRange must be {start:int, end:int, count:int}");
  } else if (rr.start < 0 || rr.end < rr.start || rr.count !== rr.end - rr.start + 1) {
    bad(`receiptRange inconsistent: start=${rr.start} end=${rr.end} count=${rr.count}`);
  }

  const g = manifest.genesis;
  if (!isPlainObject(g) || !Number.isInteger(g.seq) || g.seq < 0 || typeof g.prevHash !== "string" || g.prevHash.length === 0) {
    bad("genesis must be {seq:int>=0, prevHash:string}");
  } else if (g.seq !== rr?.start) {
    bad(`genesis.seq ${g.seq} must equal receiptRange.start ${rr?.start}`);
  } else if (g.seq === 0 && g.prevHash !== GENESIS) {
    bad(`genesis at seq 0 must anchor to ${GENESIS}, got ${JSON.stringify(g.prevHash)}`);
  } else if (g.seq > 0 && !HEX64.test(g.prevHash)) {
    bad("genesis.prevHash for seq>0 must be a sha256 checkpoint hash");
  }

  if (!isPlainObject(manifest.state) || typeof manifest.state?.cellsSha256 !== "string" || !HEX64.test(manifest.state?.cellsSha256 ?? "")) {
    bad("state.cellsSha256 must be sha256 hex");
  }

  if (manifest.supersedes !== null && (typeof manifest.supersedes !== "string" || !HEX64.test(manifest.supersedes))) {
    bad("supersedes must be null or a sha256 manifestHash");
  }

  if (typeof manifest.manifestHash !== "string" || !HEX64.test(manifest.manifestHash)) {
    bad("manifestHash missing or not sha256 hex");
  } else {
    const recomputed = computeManifestHash(manifest);
    if (recomputed !== manifest.manifestHash) {
      bad(`manifestHash mismatch: recomputed ${recomputed}, carried ${manifest.manifestHash}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Mint a deterministic v0 organId: name@first-16-hex of the identity material. */
export function mintOrganId(name, material) {
  const hex = sha256Json({ name, material }).slice(0, 16);
  return `${name}@${hex}`;
}
