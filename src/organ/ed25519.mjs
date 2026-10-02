// quilt-jev-toolkit — Ed25519 v3 primitives (wave-68, lane 68-b)
//
// Spec (docs/REVERSE-ACTUALIZED-SPEC.md §10): v3 makes the checkpoint signer
// NAMABLE. v2's HMAC is symmetric — every writer holds full signing power, so
// attribution is fleet-trust, not identity. Ed25519 (node:crypto, stdlib only)
// splits the power: the private key mints, the public key verifies, and the
// public key HAS A NAME — its fingerprint.
//
// THE FINGERPRINT LAW (shared byte-for-byte with quilt-mcp-receipts' qmr3
// attribution layer): the fingerprint of an Ed25519 identity is
//
//   sha256( SPKI-PEM(public key) )   → 64 lowercase hex chars
//
// where SPKI-PEM is the normalized `SubjectPublicKeyInfo` PEM emitted by
// node:crypto's `createPublicKey(...).export({ type: "spki", format: "pem" })`
// (trailing newline included). Normalization means the fingerprint is stable
// whether it is derived from the public PEM or from the private PEM (the
// public half is derived first), and identical in both repos — the cross-repo
// proof (examples/v3-attribution-demo.mjs) leans on exactly this.

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

export const ED25519_ALG = "Ed25519";

/** The checkpoint signature covers the canonical signing payload; its length
 *  in hex is fixed by the algorithm (Ed25519 → 64 bytes → 128 hex chars). */
export const ED25519_SIG_HEX = /^[0-9a-f]{128}$/;

/** Normalize any usable key material (public PEM, or a private PEM from which
 *  the public half is derived) into the canonical SPKI PEM string. */
export function normalizePublicPem(pem) {
  return createPublicKey(pem).export({ type: "spki", format: "pem" });
}

/** THE FINGERPRINT LAW — sha256 over the normalized SPKI PEM. */
export function ed25519PublicKeyFingerprint(publicKeyPem) {
  return createHash("sha256").update(normalizePublicPem(publicKeyPem)).digest("hex");
}

/** Sign a UTF-8 payload with an Ed25519 private key PEM → 128 lowercase hex. */
export function ed25519SignHex(privateKeyPem, payload) {
  return cryptoSign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("hex");
}

/** Verify a 128-hex Ed25519 signature over a UTF-8 payload under a public key
 *  PEM. Never throws on bad material — unusable keys/sigs verify false. */
export function ed25519VerifyHex(publicKeyPem, payload, sigHex) {
  if (typeof sigHex !== "string" || !ED25519_SIG_HEX.test(sigHex)) return false;
  try {
    return cryptoVerify(null, Buffer.from(payload, "utf8"), publicKeyPem, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

/** Test/demo convenience: a fresh identity, generated at RUNTIME (test keys
 *  are never committed — the key-scan law). Returns PEMs + fingerprint. */
export function generateEd25519Keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = normalizePublicPem(publicKey.export({ type: "spki", format: "pem" })).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { publicKeyPem, privateKeyPem, publicKeyFingerprint: ed25519PublicKeyFingerprint(publicKeyPem) };
}
