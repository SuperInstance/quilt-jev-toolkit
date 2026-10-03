// quilt-jev-toolkit — zeroclaw organ adapter (FB6, spec §FB6 / lane note
// deltas/2026-10-03-fb6-organ-custody-spec.md in fleet-seeds)
//
// A zeroclaw journal (tools/zeroclaw/zeroclaw-journal.jsonl in fleet-seeds)
// boots as an organ. Mapping discipline (§9-style):
//   - every journal row is a WRITE → one organ receipt each
//   - the JEV canary is a WITNESS → a no-op witness receipt, never state
//   - replay re-derives every row_hash and re-links prev_hash from GENESIS;
//     the recomputed tip IS the state — nothing trusted, everything re-proven
//
// Byte-compatibility law: zeroclaw's row_hash is fnv1a64 over Python's
// json.dumps(obj, sort_keys=True, separators=(",", ":")) with ensure_ascii
// DEFAULT (True). Both quirks are reproduced here exactly — drift in either
// is ZC_REPLAY_DIVERGENCE, not a shrug.

import { GENESIS, canonicalJson, sha256Json, sha256 } from "./manifest.mjs";
import { snapshot } from "./snapshot.mjs";

// --- Python-canonical JSON (ensure_ascii=True) ----------------------------
function pyEscapeAscii(s) {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 0x80) { out += ch; continue; }
    if (code <= 0xffff) { out += "\\u" + code.toString(16).padStart(4, "0"); continue; }
    // astral: Python emits a surrogate PAIR
    const hi = 0xd800 + ((code - 0x10000) >> 10);
    const lo = 0xdc00 + ((code - 0x10000) & 0x3ff);
    out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
  }
  return out;
}

export function pyCanon(value) {
  // identical structural rules to manifest.canonicalJson, but strings are
  // escaped in Python json.dumps ORDER: specials (backslash first!) then
  // non-ASCII as \uXXXX (ensure_ascii=True). Order matters — escaping the
  // backslash after inserting \uXXXX would double-escape the escapes.
  if (value === undefined) throw new TypeError("pyCanon: undefined (fail-closed)");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("pyCanon: non-finite number");
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    const specials = value
      .replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      .replace(/\x08/g, "\\b").replace(/\x0c/g, "\\f")
      .replace(/\x0a/g, "\\n").replace(/\x0d/g, "\\r").replace(/\x09/g, "\\t")
      .replace(/[\x00-\x07\x0b\x0e-\x1f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    return '"' + pyEscapeAscii(specials) + '"';
  }
  if (Array.isArray(value)) return "[" + value.map(pyCanon).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => pyCanon(k) + ":" + pyCanon(value[k])).join(",") + "}";
}

// --- fnv1a64, matching zeroclaw.py exactly --------------------------------
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

export function fnv1a64(text) {
  // Python hashes the UTF-8 ENCODING of the canon string
  const bytes = new TextEncoder().encode(text);
  let h = FNV_OFFSET;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

// --- mapping ---------------------------------------------------------------
export const ZC_FIELDS = ["ts", "agent", "model", "order", "prompt_sha256",
  "output_file", "output_sha256", "usage", "latency_s", "prev_hash"];
// cites is OPTIONAL: genesis rows predate the FB5 cite envelope and carry no key
export const ZC_OPTIONAL = ["cites"];

// Genesis anchor representations across zeroclaw's history: v0/v0.5 rows carry
// prev_hash null (Python None); run() today writes the string "genesis". Both
// normalize to GENESIS — anything else on row 0 is unowned history (refused,
// v0 law: no checkpoint support in this adapter).
const GENESIS_PREVS = new Set([null, "genesis"]);
function isGenesisPrev(v) { return GENESIS_PREVS.has(v); }

export function toReceipt(row, i) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    const e = new Error(`ZC_SCHEMA_DRIFT: row ${i} is not an object`); e.code = "ZC_SCHEMA_DRIFT"; throw e;
  }
  for (const f of ZC_FIELDS) {
    if (!(f in row)) {
      const e = new Error(`ZC_SCHEMA_DRIFT: row ${i} missing field '${f}'`); e.code = "ZC_SCHEMA_DRIFT"; throw e;
    }
  }
  if (typeof row.row_hash !== "string" || !/^[0-9a-f]{16}$/.test(row.row_hash)) {
    const e = new Error(`ZC_SCHEMA_DRIFT: row ${i} row_hash not 16-hex fnv1a64`); e.code = "ZC_SCHEMA_DRIFT"; throw e;
  }
  return {
    seq: i,
    type: "zeroclaw.row",
    hash: row.row_hash,
    prev: isGenesisPrev(row.prev_hash) ? GENESIS : row.prev_hash,
    op: Object.fromEntries(Object.entries(row).filter(([k]) => k !== "row_hash")),
  };
}

export class OrganBootError extends Error {}

/** The courtroom: re-derive every hash, re-link the chain. Throws OrganBootError. */
export function verifyZeroclawRows(rows) {
  const receipts = rows.map((r, i) => toReceipt(r, i));
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const recomputed = fnv1a64(pyCanon(r.op));
    if (recomputed !== r.hash) {
      throw new OrganBootError(
        `ZC_ROW_HASH_MISMATCH: row ${i} stored ${r.hash}, recomputes to ${recomputed}`);
    }
    if (i === 0) {
      if (r.prev !== GENESIS) {
        throw new OrganBootError(
          `ZC_CHAIN_BROKEN: genesis anchor '${JSON.stringify(rows[0].prev_hash)}' is not a known genesis representation (null or "genesis")`);
      }
    } else if (isGenesisPrev(rows[i].prev_hash) || r.prev !== receipts[i - 1].hash) {
      throw new OrganBootError(
        `ZC_CHAIN_BROKEN: row ${i} prev ${rows[i].prev_hash} != row ${i - 1} hash ${receipts[i - 1].hash}`);
    }
  }
  return receipts;
}

/** The receipted state: the journal tip as re-derived by replay. */
export function stateOfReceipts(receipts) {
  const tip = receipts[receipts.length - 1];
  return {
    rows: receipts.length,
    tip: tip.hash,
    orders: receipts.map((r) => r.op.order),
    models: [...new Set(receipts.map((r) => r.op.model))],
  };
}

/**
 * Snapshot a zeroclaw journal (array of row objects) into an organ bundle.
 * opts.canary: { question, answer, score } → appended as a WITNESS receipt
 * (no-op; §9 discipline — the canary flags, it never decides).
 */
export function snapshotZeroclaw(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const e = new Error("ZC_SCHEMA_DRIFT: empty journal — no custody, no organ"); e.code = "ZC_SCHEMA_DRIFT"; throw e;
  }
  const name = opts.name ?? "zeroclaw-journal";
  const receipts = verifyZeroclawRows(rows); // fail-closed at snapshot too
  const state = stateOfReceipts(receipts);
  const ledger = receipts.map((r) => ({ ...r }));
  if (opts.canary) {
    const w = { seq: ledger.length, type: "zeroclaw.canary", hash: null, prev: ledger[ledger.length - 1].hash,
                op: { witness: true, question: opts.canary.question ?? null,
                      answer: opts.canary.answer ?? null, score: opts.canary.score ?? null } };
    w.hash = fnv1a64(pyCanon(w.op));
    ledger.push(w); // witness rides the chain, changes no state
  }
  const cells = { journal: { kind: "value", value: state } };
  const bundle = snapshot(cells, ledger, { name, supersedes: opts.supersedes ?? null });
  return bundle;
}

/** Boot: full re-proof, then the organ handle. source = rows array. */
export function bootZeroclaw(source, opts = {}) {
  const rows = Array.isArray(source) ? source : null;
  if (!rows) throw new OrganBootError("ZC_SCHEMA_DRIFT: boot source must be the journal rows array");
  const receipts = verifyZeroclawRows(rows); // recompute + re-link (fail-closed)
  const state = stateOfReceipts(receipts);
  // replay == carried-state assertion: the state IS the replay product here,
  // so the assertion is structural (snapshot in, replay out). If a caller
  // carries a bundle, re-verify its state cell against replay:
  if (opts.bundle) {
    const carried = opts.bundle.state?.cells?.journal?.value;
    if (!carried) throw new OrganBootError("ZC_STATE_MISMATCH: bundle carries no journal state cell");
    const replayed = stateOfReceipts(verifyZeroclawRows(opts.bundle.receipts.filter((r) => r.type === "zeroclaw.row").map((r) => ({ ...r.op, row_hash: r.hash }))));
    if (canonicalJson(carried) !== canonicalJson(replayed)) {
      throw new OrganBootError("ZC_REPLAY_DIVERGENCE: carried state != replay of carried receipts");
    }
  }
  const bundle = snapshotZeroclaw(rows, { name: opts.name ?? "zeroclaw-journal", canary: opts.canary });
  return {
    manifest: bundle.manifest,
    cells: bundle.state.cells,
    ledger: bundle.receipts,
    custody: {
      kind: "zeroclaw-journal",
      rows: receipts.length,
      tip: receipts[receipts.length - 1].hash,
      verifiedRange: { start: 0, end: receipts.length - 1 },
      canary: opts.canary ? { witness: true, score: opts.canary.score ?? null } : null,
    },
  };
}

/** Convenience: read a JSONL journal file → rows. */
export async function loadZeroclawJournal(path) {
  const { readFileSync } = await import("node:fs");
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
