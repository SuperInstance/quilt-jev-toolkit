# quilt-jev-toolkit — Developer Guide

## Code layout

```
src/organ/
  toyQuilt.mjs    (95)  the receipted stand-in quilt: 4 op types (init/set/render),
                        pure, clock-free; stateOf/applyOp are the adaptation seam
  manifest.mjs    (217) canonical JSON + sha256 content addressing; manifest
                        builder/verifier for quilt.organ.manifest/v1
  snapshot.mjs    (140) cells + ledger → verified bundle {manifest, state, receipts}
  boot.mjs        (597) THE COURTROOM: chain verify (GENESIS or pinned checkpoint),
                        replay == state assertion, checkpoint dispatch (v2 HMAC /
                        v3 Ed25519), rotation eras, revocation enforcement,
                        OrganBootError fail-closed surface
  nest.mjs        (224) nesting envelope; double-entry organ DEBIT / host CREDIT;
                        verifyDoubleEntry audit (never auto-repairs)
  rewind.mjs      (405) stateAt (pure time travel), rewind (bundle view / organ
                        destructive + compensating host receipt), transact
                        (PREPARE/COMMIT all-or-nothing writes)
  checkpoint.mjs  (297) signCheckpoint (HMAC-SHA256), signCheckpointEd25519,
                        carvePartialCustody, carveRotatedCustody; mint runs the
                        full courtroom BEFORE signing
  ed25519.mjs     (69)  runtime keygen (never committed), fingerprint law
                        (sha256 of normalized SPKI PEM), sign/verify hex
  chronoOps.js    (390) §9 adapter: mapChronoChain (1 link → 1 receipt, same seq,
                        chrono:{seq,hash} embedded) + bootChrono (signature →
                        anchor → sidecar → boundary → mapping → replay == signed
                        state → real boot())
jev_client.py           minimal JEV client: list_models, ask, noul/choice/score
                        builders, canon_gate(); env-read key (TYPESAFE_API_KEY or
                        TYPESAFEAI_KEY); BASE https://api.typesafe.ai
canon_gate.py           CLI: gate one file or --batch a directory; JSON or table
test/organ.test.mjs     54 v0–v3 tests incl. the self-consistent forged chain
tests/chrono-interop.test.mjs  16 §9 tests + the LIVE interop (skips without ../quilt-chrono)
tests/revocation.test.mjs      §11 enforcement tests (wave-69)
tests/fixtures/chrono-fixture.json   committed chrono seal + sidecar links
examples/  greeter-organ.mjs (4 cells, 12 receipts) · boot-demo.mjs ·
           rewind-demo.mjs · v3-attribution-demo.mjs · keyring-mint.mjs ·
           upload-v1-states.mjs · receipts/ (4 evidence JSONs)
receipts/  68-b-death-audit.md · v3-cross-repo-proof.md
scripts/   keyscan.mjs (pre-push credential ritual) · vendor-chrono-fixture.mjs
docs/      REVERSE-ACTUALIZED-SPEC.md (§1–§11) + this wave-69 package
DESIGN.md  design passes, newest first, with REJECTED alternatives
README.md  the version-by-version protocol story (v0→v3, §9, §11)
FLEET_GATE_RESULTS.md / JEV_FLEET_GATE.md   the 50-repo canon gate (table + raw log)
```

## Core concepts

1. **Bundle** — `{ manifest, state, receipts }`; content-addressed (I1): the
   manifest hash is a pure function of content because cell order is sorted
   and JSON is canonical.
2. **The courtroom** (`boot`) — verify schema → verify manifest → re-verify
   every receipt hash from `GENESIS` or a pinned checkpoint → replay on empty
   cells → assert hash-equality with carried state. Only then does anything
   else run. All failures throw `OrganBootError` (never a partial boot).
3. **Custody** — `organ.custody` provenance on booted organs:
   `{kind: "hmac-sha256", anchoredAt}` (v2 — honestly nameless) or
   `{kind: "ed25519", anchoredAt, publicKeyFingerprint}` (v3), or
   `{kind: "chrono-seal", ...}` (§9), or `signers: [...]` under rotation.
4. **Double entry** — nesting books organ DEBIT + host CREDIT; rewind past a
   nest boundary emits ONE `organ.rewind` host receipt carrying the evidence
   list of superseded credits; `verifyDoubleEntry` nets to zero or names the
   code (`DOUBLE_ENTRY_UNBALANCED / _HASH_MISMATCH / _STATE_MISMATCH /
   REWIND_INVALID`).
5. **seq is time** — receipts carry no wall-clock; replay determinism (I3)
   depends on it. `stateAt` is pure; `rewind` on bundles is a pure view, on
   organs destructive-but-proven.
6. **The JEV question objects** — `{type: "noul"|"choice"|"score",
   instructions, criteria}`; `criteria` required for choice (dict) and score
   (list). `ask()` returns `{model, answers, usage}`; `canon_gate()` reduces
   it to `{canon_p, is_canon, depth, domain, usage}`.

## How to extend

### Add an organ op type (grow the toy substrate — carefully)

The toy's law is a tiny closed vocabulary (`init/set/render`). To add an op:
(1) extend `toyQuilt.mjs`'s switch and keep it pure and clock-free; (2) extend
`test/organ.test.mjs` with a replay-determinism test for the new op (boot
twice, hash-equal); (3) check every fail-closed code still names its condition.
If you actually need a richer substrate, the doctrine says adapt, don't grow:
implement `quiltApply / applyOp / stateOf` equivalents (see DESIGN.md §4's
rejected Alternative A) — as `chronoOps.js` did for quilt-chrono.

### Add a checkpoint scheme (beyond HMAC + Ed25519)

1. Extend `checkpoint.mjs` with a `sign<X>Checkpoint` that: runs the FULL boot
   courtroom first, then signs the canonical triple `{hash, manifestHash, seq}`.
2. Register the algorithm in `boot.mjs`'s `verifySignedCheckpoint` dispatch
   (`alg` discriminator); fail closed with `CHECKPOINT_MALFORMED` on unknown
   alg and `CHECKPOINT_SIGNATURE_INVALID` on forgery.
3. Name the signer honestly: if the scheme is symmetric, custody must record
   the nameless kind (v2's `{kind:"hmac-sha256"}` is the precedent); if
   asymmetric, record a fingerprint computed exactly as `ed25519.mjs` does
   (sha256 of the normalized SPKI PEM — the cross-repo law).
4. Add carve/boot tests: roundtrip, forgery, wrong-key, era rotation, and
   revocation interaction (§11) in `tests/revocation.test.mjs`.

### Add a chrono-style adapter for another substrate

Copy the shape of `src/organ/chronoOps.js`: a `map<X>Chain(links)` that maps
1 source link → exactly 1 organ receipt at the same seq (no-op witness
receipts are legal and load-bearing — dropping them breaks seq alignment),
embedding `{x: {seq, hash}}` provenance and no wall-clock; then a
`boot<X>(bundle, opts)` that runs signature → anchor → chain verify →
boundary pin → mapping → mapped-replay == signed state → the REAL `boot()`.
Semantic refusals get named codes (`CHRONO_OP_UNMAPPABLE` is the precedent).

### Extend the JEV client

`jev_client.py` is deliberately minimal (stdlib only). To add a question
builder: mirror `noul/choice/score` (return the exact wire dict, `type`
discriminator always present). To add a runner like `canon_gate`: keep it a
pure function `(text, ...) → dict` with the gate threshold a keyword arg
(`gate_threshold=0.7`). Credentials stay `os.environ` reads — `_hdr()`
currently prefers `TYPESAFE_API_KEY` then requires `TYPESAFEAI_KEY`; keep that
env-read pattern and never log or persist the value.

## Testing

```bash
npm test
# Measured 2026-10-04: 74 tests — 73 pass, 0 fail, 1 skip
# (skip = LIVE chrono-interop; requires ../quilt-chrono checked out)
npm run demo            # v0/v1/v2/v3 stages + receipts written
npm run demo:rewind     # v1 stages + rewind receipt
npm run fixture:chrono  # regenerate tests/fixtures/chrono-fixture.json
                        # (NEEDS ../quilt-chrono present; test-only key)
```

Green means: every fail-closed code has a test that provokes it; the
self-consistent forged chain (re-hashed by an "attacker") is caught by replay;
forged host credits are caught by double-entry; the committed chrono fixture
boots. The LIVE interop test additionally proves byte-equality with
quilt-chrono's own `verifyCustody` when the sibling is present.

## Conventions

- **Fail-closed codes are SCREAMING_SNAKE** and each is named in README + spec
  (`SCHEMA_DRIFT`, `MANIFEST_INVALID`, `STATE_HASH_MISMATCH`,
  `RECEIPT_HASH_MISMATCH`, `CHAIN_GAP`, `CUSTODY_GAP`,
  `CUSTODY_CHECKPOINT_MISMATCH`, `REPLAY_DIVERGENCE`, `REPLAY_INVALID_OP`,
  `DUPLICATE_NEST`, `DOUBLE_ENTRY_*`, `CHECKPOINT_*`, `E_KEY_REVOKED`,
  `CHRONO_*`, `REWIND_*`, `OP_APPLY_FAILED`). A new failure mode needs a new
  named code, a spec row, and a test.
- **Receipts record hashes and fingerprints, never key material** (see the
  v3-attribution receipt: fingerprint + sig + hashes only). The keyscan law:
  `node scripts/keyscan.mjs` before every push; matched VALUES are never
  printed even by the scanner.
- **Demos write their own evidence receipts** (`examples/receipts/*.json`,
  schema-stamped, lane-stamped); regenerate them with the demos rather than
  hand-editing.
- **Version bands are additive**: v0 laws are never touched by v1/v2/v3 (the
  README states v1 "carried over v0's law untouched"); the suite accumulates
  per band (23 → 34 → 44 → 54 → 70 → 74 as bands and §9/§11 landed).
- **The spec is reverse-actualized**: docs/REVERSE-ACTUALIZED-SPEC.md describes
  what the code already embodies, section by section; keep it in lockstep when
  you change behavior.
- **No git operations in doc lanes; no commits with secrets** — .gitignore
  already excludes `node_modules/`, `.env*`, `receipts/raw/`, `*.local.*`.

## Gotchas for editors

- **`boot.mjs` is the most delicate file in the fleet's custody story** (597
  lines): the failure-code surface, alg dispatch, era replay, and revocation
  all interlock. Change one verdict string and tests + spec + README all need
  the same edit.
- **`toyQuilt.mjs` must stay byte-stable**: replay determinism across every
  stored bundle depends on its op semantics. Adding ops is additive; changing
  existing ones orphans every committed receipt hash.
- **Manifest ordering is load-bearing** (I1): sorted cells, canonical JSON.
  Any "cleanup" of ordering changes manifestHash for identical content.
- **`mapChronoChain` is 1:1 by law**: merging or dropping links breaks seq
  alignment with the sealed sidecar — the tests treat it as history forgery.
- **Python side has no packaging**: `jev_client.py` / `canon_gate.py` are run
  from the repo root (`sys.path` insert); there is no pip package — don't add
  imports that assume one.
- **README "Files" is stale**: it lists `discovery_log.md` (absent). Trust
  the tree; fix the list if you touch it.
- **The upload path is dialect-adapted**: `examples/upload-v1-states.mjs`
  speaks the worker's `quilt.organ.v1` dialect; native-dialect uploads were
  receipted as refused (DIALECT_DRIFT). Don't "simplify" the adapter away.
