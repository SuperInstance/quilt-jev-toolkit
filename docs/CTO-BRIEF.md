# quilt-jev-toolkit — CTO Brief

## One-paragraph value statement

quilt-jev-toolkit gives the fleet two durable assets: a measured, copy-paste
client for LLM-as-judge gating (the wire protocol other lanes reused verbatim
when their own transport died), and the Cell-Organ Snapshot & Boot protocol —
a fail-closed custody format that turns any cell group's history into a
content-addressed, signature-anchored bundle a fresh process can prove and
boot. If your agents must survive crashes, handoffs, and hostile storage, this
repo is the smallest working answer the fleet has: nothing trusted, everything
re-proven, every undo an auditable double-entry receipt.

## What it does & for whom

For platform teams building durable agent runtimes: (1) organ custody —
snapshot / boot / nest cell groups with five proven invariants (content
addressing, chain of custody, deterministic replay, manifest-as-claim,
nesting without host breakage); (2) time travel — pure `stateAt` queries,
proven rewinds with compensating entries, all-or-nothing transactions;
(3) scale + trust — HMAC (v2) and Ed25519 (v3) checkpoints with partial
custody (O(tail) boots), named signers, key rotation, and revocation
enforcement (wave-69); (4) substrate interop — sealed quilt-chrono sheets boot
as organs via a 1:1 receipt adapter (§9); (5) judge gating — `jev_client.py`
and `canon_gate.py` for canon-promotion decisions, with the fleet's 50-repo
gate results shipped as evidence.

## Maturity assessment

**Working and unusually well-proofed for its size** — the organ protocol is
past prototype and approaching hardened:

- 74 tests across v0–v3 + §9 + §11 (measured 2026-10-04: 73 pass, 0 fail,
  1 conditional skip), 0.34 s; demos run end-to-end and write their own
  evidence receipts; zero dependencies (Node >= 18).
- The proof suite includes the adversarial cases most repos skip: a
  self-consistent forged chain (re-hashed by an attacker) that only replay
  catches; forged host credits caught by double-entry; three independent
  forgery shapes on rewind evidence.
- Real-world touches: uploads to a live Cloudflare Worker store with a
  receipted budget; a cross-repo proof where quilt-mcp-receipts' own verifier
  accepted this repo's identity (v3); a dead-lane audit (68-b) closed by a
  finisher with every staged test passing.
- Honest residuals: the underlying cell substrate is a toy stand-in by
  design; two dialects (toolkit vs worker) coexist behind an adapter; the JEV
  discovery rounds are receipted history (the API key was lost in wave-67).

## Risks

| Risk | Status / mitigation |
|---|---|
| Credential leakage (the fleet's observed failure mode) | Mitigated: env-read keys only, runtime-minted keys, keyscan pre-push ritual, wave-67/68 history purge upstream; tree scans CLEAN (2026-10-04) |
| fnv1a-adjacent weakness? N/A here — sha256 content addressing | The custody layer uses sha256; HMAC-SHA256/Ed25519 for checkpoints; the weak checksum lives in sibling ledgers, not in bundles |
| Toy substrate under the protocol | Documented design decision with an adaptation seam (`quiltApply/applyOp/stateOf`); risk is adoption friction, not correctness |
| Two storage dialects (manifest/v1 vs worker v1) | Contained by the receipted adapter; unification parked (lane 64-c) — a known, named debt |
| Key distribution is trust-on-first-use | Honest scope (spec §10.7); revocation enforcement closes forward use; signed-statement layer parked by design |
| Lost JEV key → oracle side unusable | Bounded: the Node protocol is independent; protocol verbatim-reuse (Task 67-j) proved vendor independence |

## Cost profile

Near-zero: no dependencies, no services, sub-second proofs, demos in seconds.
Storage costs are the bundles themselves (content-addressed JSON); the one
external service (organ store on Cloudflare Workers) is free-tier and was used
under an explicit ≤2-upload budget, receipted. The JEV side costs ≈
0.001–0.005 USD per gated submission when a key exists (Sept 2026 pricing, as
recorded). Everything runs on free tiers.

## Strategic options

- **Invest** (recommended if durable agent state matters to the fleet): land
  the protocol on a real cells/ledger substrate (the named adaptation seam),
  unify the storage dialect, and ship the parked signed-revocation statements
  — those three close the last honest gaps.
- **Maintain**: the suite is instant and the fail-closed surface stable; the
  repo can sit as the custody reference while other lanes consume it.
- **Harvest learnings**: the reverse-actualized spec method (spec written
  backward from proven code, with rejected alternatives recorded) and the
  68-b death-audit pattern are process exports worth more than the code.
- **Retire**: not recommended — jev-quilt's bookkeeper doctrine and the
  organ-custody story are increasingly the fleet's durability backbone; the
  cross-repo v3 proof ties it to quilt-mcp-receipts.

## Integration surface

- **Upstream**: jev-quilt (doctrine + oracle measurements; its Bookkeeper law
  is the ledger ancestor), TypeSafe JEV API (judge, env-keyed), quilt-chrono
  (sealed sheets, booted via §9).
- **Downstream**: any runtime that needs proven state restoration (boot),
  host quilts that nest organs, the Cloudflare organ store
  (quilt-organ-workers), quilt-mcp-receipts (shared Ed25519 fingerprint law,
  cross-proven), and any lane reusing the JEV wire protocol verbatim
  (demonstrated in wave-67).
- **Sibling posture**: jeviter (same receipt discipline, checksum tier),
  jev-quilt (doctrine tier) — this repo is the custody tier of the same
  family.

*Prepared for the wave-69 documentation package; test counts measured
2026-10-04; all key/credential references are env-var names only.*
