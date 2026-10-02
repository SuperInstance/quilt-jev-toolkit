# 68-b death audit — what the dead lane left, what the finisher (68-b-r2) found

Audited by lane 68-b-r2 against HEAD `d943d27` (origin/main verified identical —
`git fetch` + `rev-list --left-right --count HEAD...origin/main` = `0 0` on both
repos; **no parallel incarnation pushed**).

## Toolkit dirty set (`quilt-jev-toolkit` @ d943d27, 7 paths)

| path | verdict | evidence |
|---|---|---|
| `src/organ/ed25519.mjs` (NEW) | **COMPLETE** | fingerprint law (sha256 of normalized SPKI PEM), sign/verify hex, runtime keygen; never throws on bad material |
| `src/organ/checkpoint.mjs` | **COMPLETE** | `signCheckpointEd25519` (full courtroom before signing the canonical triple {hash, manifestHash, seq}), `carveRotatedCustody` (multi-era, keyless + mechanical, anchor-mismatch refusals) |
| `src/organ/boot.mjs` | **COMPLETE** | alg-dispatch in `verifySignedCheckpoint` (fingerprint equality then sig), `verifyCheckpointEd25519` doorway, 4d shared `anchorManifestVerdict`, 4f rotation eras (replay across key boundaries), custody provenance `signer`/`signers` incl. the honest hmac residual `{kind:"hmac-sha256"}` |
| `test/organ.test.mjs` | **COMPLETE** | 10 new v3 tests: roundtrip+provenance, fingerprint law, forgery (`CHECKPOINT_SIGNATURE_INVALID` shapes), wrong-key, courtroom (unsigned gap / no key / unknown alg), rotation 2 eras (HMAC→Ed25519), wrong-era keys, era-bridge tamper, re-snapshot, mint refusals |
| `docs/REVERSE-ACTUALIZED-SPEC.md` | **COMPLETE** | §10 written (+§8.5 park list un-struck); references wired from §7/§8 |
| `README.md` | **COMPLETE** | v3 section, test counts updated to 70 (54 v0–v3 + 16 chrono) |
| `package.json` | **COMPLETE** | description mentions v3; test script already globs `test/` + `tests/` |

**Suite state at audit: 70 tests — 69 pass, 0 fail, 1 skip** (the pre-existing
§9 LIVE chrono-interop test, skipped when the quilt-chrono sibling is absent —
the committed fixture carries that proof). All v0/v1/v2/§9 paths green and
untouched in behavior.

**Gaps left by the death (all closed by 68-b-r2):**
1. `examples/v3-attribution-demo.mjs` — referenced twice in `ed25519.mjs` comments, never written → created, emits `examples/receipts/v3-attribution-demo-receipt.json` (fingerprints + hashes only, never key material).
2. Cross-repo proof (toolkit checkpoint ↔ qmr2 rows under one identity) — not started → receipted in `receipts/v3-cross-repo-proof.md`.
3. This audit receipt.

**Probable cause of death:** backend adapter timeout (per fleet note) — the code
shows no incompleteness; the lane died after the work, before the demo/proof/
commit stage. Every staged test passes as left.

## Receipts dirty set (`quilt-mcp-receipts` @ 2df417d, 2 paths)

| path | verdict | evidence |
|---|---|---|
| `server.mjs` | **COMPLETE** | v0.3.0; sig-scheme registry (hmac-sha256 default / ed25519), `sigAlg`+`sigKeyFp` additive fields, keyring validation (`E_BAD_KEYRING` incl. mislabeled-key check), `E_UNKNOWN_SIGNER` fail-closed (no keyring, unknown fp), `E_SIGNER_MALFORMED`, `verify_attribution` tool under `--v3`/`V3=1`, append never rewrites shape |
| `test/mcp-client.mjs` | **PARTIAL** | adds `v3` to `McpClient` (flag + env) — the client was made READY but no v3 tests were written |

**Gaps left by the death (all closed by 68-b-r2):**
1. `docs/qmr2-design.md` **§8** — referenced five times in `server.mjs` ("docs/qmr2-design.md §8"), never written → written (the attribution layer spec).
2. v3 test suite → `test/v3-attribution.test.mjs` (new file; qmr1/v1 suites untouched).
3. Cross-repo proof + key hygiene + commit/push.

**Suite state at audit: 30/30 pass** (qmr1 + qmr2 + conformance, untouched).

## Key hygiene at audit time

Staged sets scanned for `gsk_`, `sk-`, `ghp_`, `apikey_`, `cfut_`, `moth_` AND
`BEGIN …PRIVATE KEY`: the only private-key material is the *inline-generated*
test/demo keypair law (`generateEd25519Keypair()` at test time; demo keygen at
run time) — **no committed static key files**. Zero token hits.
