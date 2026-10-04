# quilt-jev-toolkit — Knowledge Map
> The index of indexes for this repo.

## In this repo

- `src/organ/toyQuilt.mjs` — the receipted stand-in quilt (init/set/render;
  pure, clock-free); the adaptation seam when a real substrate lands.
- `src/organ/manifest.mjs` — canonical JSON + sha256 content addressing;
  `quilt.organ.manifest/v1` build/verify.
- `src/organ/snapshot.mjs` — cells + ledger → verified bundle (the custody
  claim).
- `src/organ/boot.mjs` — the courtroom: chain verify, replay == state,
  checkpoint alg dispatch, rotation eras, §11 revocation, OrganBootError
  fail-closed surface.
- `src/organ/nest.mjs` — nesting envelope; organ DEBIT / host CREDIT double
  entry; verifyDoubleEntry audit.
- `src/organ/rewind.mjs` — stateAt (pure), rewind (bundle view / organ
  destructive + one compensating host receipt), transact (all-or-nothing).
- `src/organ/checkpoint.mjs` — signCheckpoint (HMAC-SHA256),
  signCheckpointEd25519, carvePartialCustody, carveRotatedCustody.
- `src/organ/ed25519.mjs` — runtime keygen (never committed), the fingerprint
  law (sha256 of normalized SPKI PEM), sign/verify.
- `src/organ/chronoOps.js` — §9 adapter: mapChronoChain (1 link → 1 receipt,
  same seq) + bootChrono courtroom for sealed quilt-chrono sheets.
- `jev_client.py` — the minimal JEV wire client other lanes copied verbatim
  (worklog Task 67-j); env-read key; noul/choice/score builders; canon_gate().
- `canon_gate.py` — CLI gate: one file or --batch a directory; canon-p /
  depth / domain / CANON-or-draft.
- `test/organ.test.mjs` — 54 v0–v3 proofs (incl. the self-consistent forged
  chain caught by replay).
- `tests/chrono-interop.test.mjs` — 16 §9 proofs + the LIVE interop test
  (skips without ../quilt-chrono; the fixture carries the proof).
- `tests/revocation.test.mjs` — §11 enforcement proofs (wave-69).
- `tests/fixtures/chrono-fixture.json` — the committed sealed chrono sheet.
- `examples/` — greeter-organ.mjs (4 cells / 12 receipts), boot-demo.mjs,
  rewind-demo.mjs, v3-attribution-demo.mjs, keyring-mint.mjs,
  upload-v1-states.mjs (dialect adapter for the worker store).
- `scripts/keyscan.mjs` — the pre-push credential scanner (HEAD + staged +
  worktree; masked output; suppression law) — born from the cot-quilt
  incident (2026-10-01).
- `scripts/vendor-chrono-fixture.mjs` — regenerates the chrono fixture
  (needs ../quilt-chrono; test-only key).
- `.gitignore` — excludes `node_modules/`, `.env*`, `receipts/raw/`,
  `*.local.*` (the env-file law).

## Pre-existing docs (everything before wave-69)

- `README.md` — the version-by-version protocol story: organ boot v0 (5
  commands, invariants I1–I5, fail-closed rules), v1 rewind family, v2
  checkpoints + partial custody, CHRONO BOOT (§9), v3 Ed25519 attribution +
  rotation, quick start (JEV), discovery results (rounds 1–9), files list
  (partially stale), "JEV is one signal" honesty, gotchas.
- `DESIGN.md` — design passes newest-first with REJECTED alternatives: §4
  chrono-op adapter (A: teach toyQuilt — rejected as dishonest-to-history;
  B: discard reads — rejected as history forgery; shipped: translation
  module).
- `docs/REVERSE-ACTUALIZED-SPEC.md` — the protocol doctrine §1–§11: the
  far-ahead image, invariants, manifest format, fail-closed rules (§4),
  nesting envelope (§5), acceptance (§6), v1 (§7), v2 (§8 incl. §8.3 fail-
  closed tables and §8.5 park list), §9 chrono, §10 v3 (incl. §10.7 honest
  scope), §11 revocation (enforcement live; signed statements parked).
- `FLEET_GATE_RESULTS.md` — the 50-repo canon gate results (top: quilt-canary
  0.70, jev-quilt 0.60, quilt-c 0.57) with the run instruction.
- `JEV_FLEET_GATE.md` — the raw gate output log (per-repo canon-p/domain
  lines; + marks the ≥0.5 canon band).
- `receipts/68-b-death-audit.md` — the audit of a dead lane: what 68-b left
  complete (7 paths), what the finisher (68-b-r2) closed, the probable cause
  of death, and the parallel quilt-mcp-receipts dirty set.
- `receipts/v3-cross-repo-proof.md` — one Ed25519 identity (fingerprint only,
  key never persisted) whose checkpoint this repo verifies and whose qmr2
  attribution rows quilt-mcp-receipts' own server verifies. Verdict ok: true.
- `examples/receipts/boot-demo-receipt.json` — lane 63-c evidence: manifest
  hashes, replay determinism (hash before == after), nest + re-snapshot.
- `examples/receipts/rewind-v1-demo-receipt.json` — lane 64-a evidence:
  4-op transaction committed, atomicity (failedOp 1, baseUnchanged), stateAt,
  rewind + compensating entry.
- `examples/receipts/rewind-v1-upload-receipt.json` — lane 64-a: both v1
  states uploaded to the live worker store under budget; dialects named;
  DIALECT_DRIFT receipted.
- `examples/receipts/v3-attribution-demo-receipt.json` — lane 68-b(-r2)
  evidence: Ed25519 checkpoint + qmr2 rows under one fingerprint; sig + hashes
  only, never key material.

## In the fleet

- `SuperInstance/jev-quilt` — upstream sibling: the JEV doctrine + oracle
  measurement repo; its `typesafe_client.py` speaks the same systemone wire
  this client implements; its Bookkeeper is the receipt-chain ancestor.
- `SuperInstance/jeviter` — sibling: homeostatic iteration; same receipt
  discipline at the checksum tier; three laws one layer below the courtroom.
- `SuperInstance/quilt-mcp-receipts` — downstream partner: qmr2 attribution
  rows verified by this repo's identity in the v3 cross-repo proof; shares
  the fingerprint law.
- `SuperInstance/quilt-chrono` — sibling substrate: sealed sheets + sidecar
  chains; booted as organs via §9; also needed (test-only) to regenerate the
  fixture and to run the LIVE interop test.
- `SuperInstance/quilt-organ-workers` — downstream: the Cloudflare Worker
  organ store the upload receipt points at (dialect `quilt.organ.v1`).
- `SuperInstance/superinstance-lab` — the monorepo journal (worklog.md).

## In the journal

SuperInstance/superinstance-lab → worklog.md, grep `quilt-jev-toolkit`.
Verified lineage (2026-10-04):

- **Task 63-c** — CELL-ORGAN SNAPSHOT & BOOT v0 landed: 23/23 tests, 9/9 demo
  stages, tamper/chain-gap/replay-divergence refusals; remote==local verified
  @ ecaf2e4.
- **Task 64-a-r** — organ boot v1 sealed: rewind byte-identical,
  compensating double-entry past nest boundaries, all-or-nothing transact;
  34/34 tests, 7/7 rewind rounds @ 0895f5a.
- **Task 64-c-r** — fixture validation lane: determinism and byte-identical
  fixture gates (coverage-table cross-check vs @ ecaf2e4).
- **Task 64 / 65 (keepers)** — landings recorded (v1 @ 0894f5a5; 65-b organ
  v2 slice @ c9840b2).
- **Task 65-b** — v2: signed checkpoints + partial-custody replay seeds;
  O(tail) boot scale property; 44/44 tests, both demos PASS.
- **Task 66-d** — organ-family decomposition: read REVERSE-ACTUALIZED-SPEC
  in full (§1–§8, 26 distinct fail-closed rules across §4/§7.3/§8.3);
  decomposition JSON written with file:line evidence @ c9840b2.
- **Task 67-j** — native JEV transport dead (TYPESAFEAI_KEY lost) → protocol
  VERBATIM from quilt-jev-toolkit/jev_client.py reused with a different judge;
  the protocol's vendor-independence proven in practice.
- **Task 67-p** — credential sweep (this repo among the fleet's scrub set;
  tokens dead/revoked, purged; keyscan ritual institutionalized).
- **Task 68-a / 68-b / 68-b-r2** — §9 chrono adapter; v3 Ed25519 attribution
  (lane death + finisher audit, receipts/68-b-death-audit.md); cross-repo
  proof receipted.

## Receipts of record

- `examples/receipts/boot-demo-receipt.json` — proves v0 custody end-to-end:
  snapshot → nest → re-snapshot with replay determinism
  (`7d5e08940c44b568…` before == after).
- `examples/receipts/rewind-v1-demo-receipt.json` — proves v1: atomic
  transaction (`OP_APPLY_FAILED` at failedOp 1 with `baseUnchanged: true`),
  stateAt, rewind + compensating entry.
- `examples/receipts/rewind-v1-upload-receipt.json` — proves live-store
  interop under budget and receipts the dialect drift.
- `examples/receipts/v3-attribution-demo-receipt.json` — proves v3
  attribution across two repos under one fingerprint.
- `receipts/v3-cross-repo-proof.md` — proves the shared fingerprint law
  (toolkit checkpoint ↔ qmr2 rows, each repo verifying the other's artifact).
- `receipts/68-b-death-audit.md` — proves lane-death recovery honesty: every
  staged path audited COMPLETE, gaps named and closed.
- `tests/fixtures/chrono-fixture.json` — proves §9 without the sibling
  present (regenerable via `npm run fixture:chrono`).

## How to search further

```bash
# Every fail-closed code and where it is thrown:
grep -rn "OrganBootError\|NestError" src/organ/ | head -30
grep -rn "throw" src/organ/boot.mjs | head -40
# The invariants as tested:
grep -n "test(" test/organ.test.mjs | head -60
# Proofs of a specific era (v2/v3/§9/§11):
grep -n "checkpoint\|ed25519\|chrono\|revo" test/organ.test.mjs tests/*.test.mjs | head -30
# Credential hygiene status:
node scripts/keyscan.mjs
# Journal lineage:
grep -n "quilt-jev-toolkit" /home/z/my-project/worklog.md
# Dialect-drift trail:
grep -rn "quilt.organ.manifest/v1\|quilt.organ.v1" examples/ docs/ README.md | head
```
