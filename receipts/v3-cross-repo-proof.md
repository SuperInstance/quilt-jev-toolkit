# v3 cross-repo proof — one Ed25519 identity, two organs, zero shared secrets

Run by lane 68-b-r2 (raw evidence: tool-results/68b-r2/cross-repo-proof.json;
the run-time identity and the temp MCP store were never persisted to any
committed file). Verdict: **ok: true**.

## The identity

- Ed25519 keypair generated AT RUN TIME (`generateKeyPairSync`) — the key-scan law.
- Fingerprint (the shared law, sha256 of the normalized SPKI PEM):
  `5c21b07074cfcd98fa515ca1d99a73ccb3c3156344b610b62afba193272174fb`

## A. quilt-jev-toolkit (organ v3)

- `signCheckpointEd25519(bundle, seq=6, privateKeyPem)` minted through the FULL
  boot courtroom; `alg:"Ed25519"`, triple {hash, manifestHash, seq}.
- `verifyCheckpointEd25519(cp, publicKeyPem)` → ok.
- `carvePartialCustody` + `boot({checkpointKey: publicKeyPem})` → live organ;
  `custody.signer = {kind:"ed25519", anchoredAt:6, publicKeyFingerprint:5c21b07074cfcd98fa515ca1d99a73ccb3c3156344b610b62afba193272174fb}`
  — fingerprint equality with the minting key asserted.

## B. quilt-mcp-receipts (qmr2 §8) — the OTHER repo's own code verifies

- The SAME private key signed 2 qmr2 rows (`sigAlg:"ed25519"`,
  `sigKeyFp:5c21b07074cfcd98fa515ca1d99a73ccb3c3156344b610b62afba193272174fb`, `sig = Ed25519("qmr1:sig:"+id)`, 128-hex).
- The real `server.mjs` (spawned stdio, `--qmr2 --v3`) accepted both via
  `append_receipt` (with the keyring) — never accepting a row it cannot attribute.
- `verify_chain {keyring}` → ok, count=2, tip advanced through both rows.
- `verify_attribution {keyring}` → per-row report naming the SAME fingerprint
  (`signedBy:{fingerprint:5c21b07074cfcd98fa515ca1d99a73ccb3c3156344b610b62afba193272174fb, verified:true, source:"keyring"}`).

## C. Fail-closed probes

- verify_chain under a keyring whose label does not match its key → refused
  (`E_BAD_KEYRING`, the trust root is broken before any row is read).
- A forged (bit-flipped) row signature is refused at append (`E_BAD_SIGNATURE`),
  so an unknown/mistyped signer can never land (E_UNKNOWN_SIGNER family).
- The toolkit side independently refuses wrong keys (`CHECKPOINT_SIGNATURE_INVALID`)
  and unknown algs (`CHECKPOINT_MALFORMED`) — pinned by its 10 v3 tests.

## Conclusion

The fingerprint law is byte-identical across the two repos: one identity mints
organ checkpoints in quilt-jev-toolkit and receipt-chain rows in
quilt-mcp-receipts, and each repo verifies the other's artifact under its OWN
law, by name. The quest-log's line lands: **the scars carry names.**
