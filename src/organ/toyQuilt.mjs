// quilt-jev-toolkit — toy quilt substrate (lane 63-c, v0 stand-in)
//
// quilt-jev-toolkit had no cells/ledger concept before this lane (it was a
// Python JEV canon-oracle toolkit). The organ protocol needs *some* quilt to
// live in, so v0 ships this minimal, deterministic substrate — receipted as a
// STAND-IN, not an upstream quilt. When the toolkit (or quilt-upstream)
// grows a real cells/ledger layer, src/organ/* moves onto it by adapting
// exactly three functions: quiltApply, applyOp, stateOf.
//
// State law (deterministic replay, spec §2 I3):
//   - cells only ever change THROUGH receipts (append-only ledger)
//   - ops are pure, total, and wall-clock-free: `seq` is time
//   - replaying a receipt chain on empty cells reproduces state bit-exactly
//
// Op vocabulary v0 (all deterministic):
//   { type: "init",   cellId, kind, value }   create a cell (fails if exists)
//   { type: "set",    cellId, value }         set a cell's value
//   { type: "render", cellId, templateId, from }  derive a cell from a
//       template string containing ((otherCellId)) placeholders
//
// The template grammar is deliberately tiny (placeholder substitution only —
// no eval, no floats, no clocks) so replay is exact everywhere.

import { makeReceipt, verifyChain } from "./manifest.mjs";

export const TOY_QUILT_OPS = ["init", "set", "render"];

/** Deterministic op evaluator: apply one op to a cells object (mutates).
 *  Throws (fail-closed) on any op that cannot be applied.
 *  Host bookkeeping receipts (op.type starting with "organ.", written by
 *  nest.mjs — organ.nest / organ.credit) are pointer receipts: they change no
 *  cells and replay as no-ops, so a host ledger containing them still replays
 *  deterministically to the host's own cells. */
export function applyOp(cells, op) {
  if (op && typeof op.type === "string" && op.type.startsWith("organ.")) {
    return undefined; // pure bookkeeping — no cell transition
  }
  switch (op.type) {
    case "init": {
      if (Object.prototype.hasOwnProperty.call(cells, op.cellId)) {
        throw new Error(`init: cell ${op.cellId} already exists`);
      }
      cells[op.cellId] = { kind: op.kind, value: op.value };
      return cells[op.cellId];
    }
    case "set": {
      const cell = cells[op.cellId];
      if (!cell) throw new Error(`set: cell ${op.cellId} does not exist`);
      cell.value = op.value;
      return cell;
    }
    case "render": {
      const tmplCell = cells[op.templateId];
      if (!tmplCell) throw new Error(`render: template cell ${op.templateId} does not exist`);
      const rendered = renderTemplate(tmplCell.value, cells, op.from);
      const cell = cells[op.cellId];
      if (!cell) throw new Error(`render: cell ${op.cellId} does not exist`);
      cell.value = rendered;
      return cell;
    }
    default:
      throw new Error(`applyOp: unknown op type ${JSON.stringify(op?.type)}`);
  }
}

/** ((cellId)) placeholder substitution. Deterministic, no eval. */
export function renderTemplate(template, cells, from) {
  if (typeof template !== "string") throw new Error("renderTemplate: template must be a string");
  return template.replace(/\(\(([A-Za-z0-9._-]+)\)\)/g, (_m, id) => {
    if (from && !from.includes(id)) throw new Error(`renderTemplate: placeholder ((${id})) not declared in from[]`);
    const cell = cells[id];
    if (!cell) throw new Error(`renderTemplate: placeholder cell ${id} does not exist`);
    return String(cell.value);
  });
}

/** Create a fresh quilt: { name, cells, ledger }. */
export function makeQuilt(name) {
  return { name, cells: {}, ledger: [] };
}

/** Apply an op to a quilt through its ledger (the only legal mutation path).
 *  Returns the appended receipt. */
export function quiltApply(quilt, op) {
  const prev = quilt.ledger.length === 0 ? "GENESIS" : quilt.ledger[quilt.ledger.length - 1].hash;
  const receipt = makeReceipt(quilt.ledger.length, op, prev);
  applyOp(quilt.cells, op); // fail-closed: if the op can't apply, the ledger is untouched
  quilt.ledger.push(receipt);
  return receipt;
}

/** Verify a quilt's own ledger invariants (contiguous hash-linked chain). */
export function verifyQuiltLedger(quilt) {
  return verifyChain(quilt.ledger, { expectedStart: 0, expectedPrev: "GENESIS" });
}
