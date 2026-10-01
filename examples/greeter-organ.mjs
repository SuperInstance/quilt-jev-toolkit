// greeter-organ — the v0 fixture organ (lane 63-c)
//
// A minimal 4-cell toy organ whose cells transform text, carrying a
// 12-receipt history (exactly 12 — asserted by the test suite).
// This is the "tiny example organ built from the repo's existing concepts"
// per the lane directive: the toolkit had no cells/ledger before this lane,
// so the fixture rides on src/organ/toyQuilt.mjs (receipted as the v0
// stand-in substrate).
//
// Cells:
//   greeting (value)   "Ahoy"            — the salutation
//   subject  (value)   "SuperInstance"   — whom to greet
//   template (value)   "((greeting)), ((subject))!" — pure text transform
//   out      (output)  derived by a `render` op — replay proves it
//
// History (seq 0..11): 4 × init, then set/render pairs that leave the organ
// saying "Ahoy, SuperInstance!" — every transition receipted, none erased.

import { makeQuilt, quiltApply } from "../src/organ/toyQuilt.mjs";

export const GREETER_EDGES = [
  { from: "greeting", to: "out" },
  { from: "subject", to: "out" },
  { from: "template", to: "out" },
];

export const GREETER_RECEIPTS = 12;

/** Build the greeter-organ's source quilt with its exact 12-receipt history. */
export function buildGreeterQuilt() {
  const quilt = makeQuilt("greeter-organ-quilt");
  const ops = [
    { type: "init", cellId: "greeting", kind: "value", value: "Hello" },
    { type: "init", cellId: "subject", kind: "value", value: "Quilt" },
    { type: "init", cellId: "template", kind: "value", value: "((greeting)), ((subject))!" },
    { type: "init", cellId: "out", kind: "output", value: "" },
    { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] }, // "Hello, Quilt!"
    { type: "set", cellId: "subject", value: "Fleet" },
    { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] }, // "Hello, Fleet!"
    { type: "set", cellId: "greeting", value: "Greetings" },
    { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] }, // "Greetings, Fleet!"
    { type: "set", cellId: "subject", value: "SuperInstance" },
    { type: "set", cellId: "greeting", value: "Ahoy" },
    { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] }, // "Ahoy, SuperInstance!"
  ];
  for (const op of ops) quiltApply(quilt, op);
  if (quilt.ledger.length !== GREETER_RECEIPTS) {
    throw new Error(`greeter fixture drift: ${quilt.ledger.length} receipts, expected ${GREETER_RECEIPTS}`);
  }
  return quilt;
}

/** The exact final state string, for receipts and assertions. */
export const GREETER_FINAL_OUT = "Ahoy, SuperInstance!";
