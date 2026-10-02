// revocation.test.mjs — §11 key revocation, ENFORCEMENT half (wave-69).
//
// The design (docs/REVERSE-ACTUALIZED-SPEC.md §11) splits revocation in two:
//   STATEMENT layer — who declares a key dead, in what format, how it reaches
//   verifiers — DESIGN-FIRST, parked (a statement format without an adoption
//   story is PKI larp; see §11's parking receipt).
//   ENFORCEMENT layer — what a verifier that ALREADY holds a revocation map
//   does with it — trivial, and implemented here:
//
//     boot(bundle, { revokedKeys: { fingerprint → revocationSeq } })
//
//   A named (Ed25519) era whose checkpoint anchors a seq AFTER the key's
//   revocation-seq refuses E_KEY_REVOKED. The era stays valid up to AND
//   INCLUDING the revocation-seq: the organ has no wall clock, seq is the only
//   ordering, and revocation is never retroactive beyond the declared closure.
//   HMAC eras have no fingerprint — nothing to revoke (rotate instead).

import test from "node:test";
import assert from "node:assert/strict";

import { boot, OrganBootError, verifyBundle } from "../src/organ/boot.mjs";
import { snapshot } from "../src/organ/snapshot.mjs";
import { makeQuilt, quiltApply } from "../src/organ/toyQuilt.mjs";
import { signCheckpoint, carvePartialCustody, signCheckpointEd25519, carveRotatedCustody } from "../src/organ/checkpoint.mjs";
import { generateEd25519Keypair } from "../src/organ/ed25519.mjs";
import { buildGreeterQuilt, GREETER_EDGES } from "../examples/greeter-organ.mjs";

// deterministic 16-receipt bundle (the organ.test.mjs v2 pattern, self-contained)
const ADVANCE = [
  { type: "set", cellId: "greeting", value: "Salutations" },
  { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] },
  { type: "set", cellId: "subject", value: "v1" },
  { type: "render", cellId: "out", templateId: "template", from: ["greeting", "subject"] },
];
const bundle = () => {
  const quilt = buildGreeterQuilt();
  for (const op of ADVANCE) quiltApply(quilt, op);
  return snapshot(quilt.cells, quilt.ledger, { name: "greeter-organ", edges: GREETER_EDGES });
};

const CP_SEQ = 7;
const LATE_SEQ = 12;
const HMAC_KEY = "fleet-checkpoint-key-65b"; // test-only shared secret, not a credential

const bootCode = (b, opts = {}) => {
  try {
    boot(b, opts);
  } catch (e) {
    if (e instanceof OrganBootError) return e.code;
    throw e;
  }
  return null; // booted
};

test("§11 enforcement: a revoked key's LATER era refuses E_KEY_REVOKED; the era closed AT the revocation-seq still boots", () => {
  const { privateKeyPem, publicKeyPem, publicKeyFingerprint } = generateEd25519Keypair();
  const cp = signCheckpointEd25519(bundle(), CP_SEQ, privateKeyPem);
  const partial = carvePartialCustody(bundle(), cp);

  // no revocation map → boots (the baseline is unchanged)
  assert.equal(bootCode(partial, { checkpointKey: publicKeyPem }), null);

  // revoked, but the checkpoint anchors AT the revocation-seq — the era closed
  // AT 7 is still valid (closure is the first seq the key may NOT anchor)
  assert.equal(
    bootCode(partial, { checkpointKey: publicKeyPem, revokedKeys: { [publicKeyFingerprint]: CP_SEQ } }),
    null,
    "revocation is not retroactive beyond the declared closure",
  );

  // the same map, but a checkpoint anchored AFTER its closure → named refusal
  const late = signCheckpointEd25519(bundle(), LATE_SEQ, privateKeyPem);
  const latePartial = carvePartialCustody(bundle(), late);
  assert.equal(
    bootCode(latePartial, { checkpointKey: publicKeyPem, revokedKeys: { [publicKeyFingerprint]: CP_SEQ } }),
    "E_KEY_REVOKED",
  );
  try {
    boot(latePartial, { checkpointKey: publicKeyPem, revokedKeys: { [publicKeyFingerprint]: CP_SEQ } });
  } catch (e) {
    assert.match(e.detail, /era closed at revocation-seq 7/);
    assert.ok(e.detail.includes(publicKeyFingerprint.slice(0, 12)), "the refusal names the revoked key");
  }
});

test("§11 rotation: the revoked era is named; an era-0 key is revocable too; earlier hmac eras are innocent", () => {
  const era1 = generateEd25519Keypair(); // HMAC era 0, Ed25519 era 1 (the §10 migration shape)
  const cp0 = signCheckpoint(bundle(), CP_SEQ, HMAC_KEY);
  const cp1 = signCheckpointEd25519(bundle(), LATE_SEQ, era1.privateKeyPem);
  const rotated = carveRotatedCustody(bundle(), [cp0, cp1]);
  const keys = { checkpointKeys: [HMAC_KEY, era1.publicKeyPem] };

  assert.equal(bootCode(rotated, keys), null, "the healthy rotation boots");

  // revoke era 1's key with closure at CP_SEQ: era 1 anchors 12 > 7 → refused.
  // Era 0's HMAC has no fingerprint — innocent by construction (nothing to revoke).
  assert.equal(
    bootCode(rotated, { ...keys, revokedKeys: { [era1.publicKeyFingerprint]: CP_SEQ } }),
    "E_KEY_REVOKED",
  );

  // era 0 itself revocable: an Ed25519 era-0 key with closure below its anchor
  const solo = generateEd25519Keypair();
  const cpA = signCheckpointEd25519(bundle(), CP_SEQ, solo.privateKeyPem);
  const partialA = carvePartialCustody(bundle(), cpA);
  assert.equal(
    bootCode(partialA, { checkpointKey: solo.publicKeyPem, revokedKeys: { [solo.publicKeyFingerprint]: 3 } }),
    "E_KEY_REVOKED",
  );
});

test("§11 shape: hmac eras are immune (no fingerprint to revoke); a malformed revocation map is refused, never partially trusted", () => {
  const cp = signCheckpoint(bundle(), CP_SEQ, HMAC_KEY);
  const partial = carvePartialCustody(bundle(), cp);
  const opts = { checkpointKey: HMAC_KEY };

  // an hmac era under ANY revocation map still boots — a shared secret has no
  // identity to revoke (§11: rotate instead)
  assert.equal(bootCode(partial, { ...opts, revokedKeys: { ["f".repeat(64)]: 0 } }), null);

  // malformed maps refuse before any era is examined
  assert.equal(bootCode(partial, { ...opts, revokedKeys: ["a".repeat(64)] }), "CHECKPOINT_MALFORMED");
  assert.equal(bootCode(partial, { ...opts, revokedKeys: { nothex: 0 } }), "CHECKPOINT_MALFORMED");
  assert.equal(bootCode(partial, { ...opts, revokedKeys: { ["a".repeat(64)]: -1 } }), "CHECKPOINT_MALFORMED");
  assert.equal(bootCode(partial, { ...opts, revokedKeys: { ["a".repeat(64)]: "seq-7" } }), "CHECKPOINT_MALFORMED");
});

test("§11 verifyBundle (non-throwing form) carries the same E_KEY_REVOKED verdict in errors[0]", () => {
  const { privateKeyPem, publicKeyPem, publicKeyFingerprint } = generateEd25519Keypair();
  const late = signCheckpointEd25519(bundle(), LATE_SEQ, privateKeyPem);
  const latePartial = carvePartialCustody(bundle(), late);
  const v = verifyBundle(latePartial, {
    checkpointKey: publicKeyPem,
    revokedKeys: { [publicKeyFingerprint]: CP_SEQ },
  });
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, "E_KEY_REVOKED");
  // and the same bundle without the map verifies clean — revocation is the
  // verifier's CHOICE, not a property of the bundle
  assert.equal(verifyBundle(latePartial, { checkpointKey: publicKeyPem }).ok, true);
});
