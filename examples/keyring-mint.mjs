// keyring-mint.mjs — the tiny keyring-minting helper (wave-69, lane 69-b).
//
// WHY THIS EXISTS: quilt-chrono's seal() gained `alg: "Ed25519"` and every
// other fleet organ that wants named-signer custody needs the same three
// things — a keypair, ITS FINGERPRINT (the shared identity law), and the
// keyring map verifiers hand to their verify calls. None of those should be
// re-derived per repo: the fingerprint law is byte-exact across
// quilt-jev-toolkit (organ v3), quilt-mcp-receipts (qmr2 §8), and the qmr2
// conformance harness — one derivation, imported everywhere.
//
//   import { mintKeyring, keyringOf } from './examples/keyring-mint.mjs';
//   const id = mintKeyring('chrono-minter');      // runtime-generated identity
//   id.fingerprint                                 // sha256 of the SPKI PEM (64-hex)
//   id.publicKeyPem / id.privateKeyPem             // PEMs (NEVER persist/commit)
//   keyringOf([id])                                // { [fingerprint]: publicKeyPem }
//
// CLI (public material only — safe to paste into a receipt):
//   node examples/keyring-mint.mjs [name]          # { name, fingerprint, publicKeyPem, keyring }
//   node examples/keyring-mint.mjs [name] --private # adds privateKeyPem (capture ONCE into your
//                                                    #  secret store; never commit, never log)
//
// KEY HYGIENE LAW (fleet-wide): keypairs are generated AT RUNTIME; committed
// static key files are forbidden. This helper returns key material in memory
// and prints only what you ask for.

import { generateEd25519Keypair, ed25519PublicKeyFingerprint } from "../src/organ/ed25519.mjs";

/**
 * Mint one named Ed25519 identity: a fresh keypair (runtime-only), its
 * fingerprint under THE shared law, and both PEMs.
 * @param {string} [name]  a label for receipts/manifests (default "anon")
 * @returns {{ name: string, privateKeyPem: string, publicKeyPem: string,
 *            fingerprint: string }}
 */
export function mintKeyring(name = "anon") {
  const kp = generateEd25519Keypair();
  return { name, privateKeyPem: kp.privateKeyPem, publicKeyPem: kp.publicKeyPem, fingerprint: kp.publicKeyFingerprint };
}

/**
 * The verifier's keyring: { fingerprint → publicKeyPem } — the exact shape
 * qmr2's verify_chain({keyring}) and the organ boot's alg-relative keying
 * both speak. Duplicate fingerprints collapse (same key, one entry).
 * @param {Array<{publicKeyPem: string}>} identities
 * @returns {Record<string, string>}
 */
export function keyringOf(identities) {
  if (!Array.isArray(identities)) throw new TypeError("keyringOf: an array of minted identities is required");
  const ring = {};
  for (const id of identities) {
    ring[ed25519PublicKeyFingerprint(id.publicKeyPem)] = id.publicKeyPem;
  }
  return ring;
}

// --- CLI ---------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const name = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "anon";
  const id = mintKeyring(name);
  const out = { name: id.name, fingerprint: id.fingerprint, publicKeyPem: id.publicKeyPem, keyring: keyringOf([id]) };
  if (process.argv.includes("--private")) {
    console.error("# WARNING: privateKeyPem below — capture ONCE into your secret store; never commit, never log.");
    out.privateKeyPem = id.privateKeyPem;
  }
  console.log(JSON.stringify(out, null, 2));
}
