# quilt-jev-toolkit — Engineering Notes

## Architecture

Two stacks, one repo: the JEV oracle client (thin, Python, stdlib-only) and
the organ protocol (Node, zero-dep, the deep half).

```
        JEV ORACLE SIDE (Python)                    ORGAN PROTOCOL SIDE (Node ESM)
┌────────────────────────────────┐          ┌─────────────────────────────────────────┐
│ canon_gate.py (CLI/batch)      │          │ examples/ (demos + evidence receipts)    │
│   ↓ canon_gate()               │          │                    ▲                     │
│ jev_client.py                  │          │ snapshot ──► boot ─┼─► nest ─► append    │
│   ask(state, questions)        │  canopy  │   (I1 content      │   (double entry)    │
│   noul / choice / score        │          │    addressing)     │                     │
│   env key: TYPESAFE_API_KEY    │          │       ▲ rewind.mjs │ checkpoint.mjs      │
│        or TYPESAFEAI_KEY       │          │       │ stateAt /  │ v2 HMAC / v3        │
└───────────────┬────────────────┘          │       │ transact / Ed25519 + §11   │
                │ POST /v1/systemone        │       │ compensating revocation    │
                ▼ (when a key exists)       │       ▼ rewind     ▼                     │
     api.typesafe.ai (judge)                │ chronoOps.js ─► boot()  ◄── manifest.mjs │
                                            │ (§9 adapter)    THE COURTROOM  toyQuilt  │
                                            └─────────────────────────────────────────┘
```

Data flow on the organ side: a quilt's cells + ledger are snapshotted into a
bundle whose manifest hash is a pure function of canonical content (I1). Boot
re-verifies the chain (I2), replays the receipt range on empty cells, and
asserts hash-equality with the carried state (I3) — nothing runs until the
courtroom passes. Writes either go through `transact` (all-or-nothing,
successor self-verified through boot) or `organ.append` after nesting (organ
DEBIT + host CREDIT, host invariants untouched — I5). Rewinds truncate to a
proven seq, rebuild by pure replay, and emit one compensating `organ.rewind`
host receipt whose evidence list marks superseded credits dead — append-only,
double-entry applied backwards. Checkpoints (v2/v3) anchor a prefix so later
boots pay O(tail); revocation (§11) refuses eras anchored after a key's
closure.

The JEV side is stateless: one POST with a batch of question objects; the
canon gate reduces three answers (noul + score + choice) to a promotion
verdict. Its load-bearing contribution to the fleet turned out to be the wire
protocol itself — other lanes copied `jev_client.py` verbatim when their own
transports died (worklog Task 67-j).

## Invariants

- **I1 Content addressing** — canonical JSON, sha256, sorted cells; enforced
  in `manifest.mjs`; tested by snapshot-twice-same-hash assertions.
- **I2 Chain of custody** — every receipt hash re-verifies from GENESIS or a
  pinned `trustedCheckpoint`; range > 0 without checkpoint → `CUSTODY_GAP`
  (`boot.mjs`; spec §2/§8).
- **I3 Deterministic replay** — `boot == replay`; no wall-clock anywhere in
  receipts (`seq` is time); enforced by boot's assertion and the replay
  determinism tests.
- **I4 The manifest is the claim** — `quilt.organ.manifest/v1` fields:
  cells(+hashes), edges, receiptRange, genesis anchor, state address,
  supersedes, self-hash.
- **I5 Nesting without host breakage** — the organ keeps its own ledger; the
  host receives only pointer receipts (`nest.mjs`; double-entry audit).
- **v1 law — nothing is trusted, everything is re-proven**: subject fully
  re-verified before any query/rewind/write (`rewind.mjs` header; spec §7).
- **v2 law — unsigned gaps stay illegal**: partial custody is legal only under
  a verified signature; `CHECKPOINT_SIGNATURE_REQUIRED` / `CUSTODY_GAP`.
- **v3 law — the signer has a name**: fingerprint = sha256 of normalized SPKI
  PEM, the same law quilt-mcp-receipts uses (that shared law is what made the
  cross-repo proof possible).
- **§11 law — revocation is enforced, not advisory**: eras anchored after
  `revocationSeq` refuse `E_KEY_REVOKED`; malformed revocation maps refuse,
  never partially apply (`tests/revocation.test.mjs`).

## Failure modes & blast radius

- **Corrupt/forged bundle** (bit rot, tamper, attacker re-hash): caught at
  boot by the named code (`STATE_HASH_MISMATCH`, `RECEIPT_HASH_MISMATCH`,
  `CHAIN_GAP`, `REPLAY_DIVERGENCE`, …); blast radius is one boot refusing —
  by design nothing partially boots.
- **Forged host credit** (a host ledger claims credits the organ never
  debited): caught by `verifyDoubleEntry` (`DOUBLE_ENTRY_*`); the audit never
  auto-repairs, so blast radius stops at the named rows.
- **Compromised checkpoint key**: v2 HMAC — every writer holds full signing
  power, so blast radius is the whole era (the honest residual, recorded in
  provenance); v3 Ed25519 — blast radius is one named key's eras, and §11
  revocation closes forward use; rotation eras are proven by replay from the
  prior anchor, so a genuine key signing an unreachable state refuses.
- **Dialect mismatch on upload**: refused and receipted (DIALECT_DRIFT
  finding); the adapter is the containment.
- **Chrono unmappables**: `CHRONO_OP_UNMAPPABLE` / `CHRONO_FLOW_UNPAIRED` —
  the adapter refuses to guess semantics; source sheet must be fixed.
- **JEV transport loss** (the key died in wave-67): the Python side is dead
  weight until a key returns; the Node side is unaffected. Fleet mitigation
  was protocol reuse with another judge (Task 67-j), which itself proves the
  protocol's independence from the vendor.

## Performance & cost envelope

- Suite: 74 tests in ~0.34 s (measured 2026-10-04) — the whole protocol proof
  is sub-second; demos each run in ~1 s.
- Boot scale: O(tail) with checkpoints vs O(history) without — the v2 scale
  property (spec §8; "booting a 10-million-receipt organ costs O(tail), not
  O(history)") is a design guarantee with tests over the carve/boot path, not
  a benchmark on 10M receipts [labeled: scale property proven structurally;
  no 10M-receipt benchmark exists].
- JEV measured (Sept 24, 2026, discovery rounds 1–9): ~0.3 s/call single,
  50 parallel calls in 3.3 s (66 ms/call), determinism p 0.980–0.990 over 10
  runs; per-submission cost ≈ 0.001–0.005 USD at JEV pricing (as recorded in
  FLEET_GATE_RESULTS/README era; unverified since the key was lost).
- Upload budget discipline: the rewind-v1 upload receipt records exactly 2
  stored uploads within a ≤2 budget (probe PUT stored nothing, HTTP 400) —
  the fleet counts and receipts its store writes.
- Zero external npm dependencies; zero services; runs on free tiers.

## Operations

- Local/CI: `npm test` (the proof suite), `npm run demo`, `npm run
  demo:rewind`; no CI workflow file in-repo at doc time — verification is
  per-lane and receipted in the journal (stated honestly; jeviter, not this
  repo, carries the GitHub Actions badge).
- Store: the fleet organ store is a Cloudflare Worker
  (`organ-boot-loader.casey-digennaro.workers.dev` per the upload receipt);
  uploads are budgeted, dialect-adapted, and receipted.
- Credentials model: **env-read only, never committed** — Python side reads
  `TYPESAFE_API_KEY` (fallback legacy `TYPESAFEAI_KEY`); Node side holds no
  secrets (Ed25519 keys are minted at runtime). The pre-push ritual is
  `node scripts/keyscan.mjs` (scans HEAD tree, staged diff, and worktree;
  prints only masked matches; exit 1 on un-receipted hits). Wave-67 (Task
  67-p) scrubbed the fleet's embedded dead tokens; wave-67/68 purged two
  tracked key files from fleet history; this tree scans CLEAN (2026-10-04).
- Cross-repo trust: verifier learns public keys trust-on-first-use (spec
  §10.7); revocation closes forward use; signed-statement revocation is
  parked (§11).

## Design decisions & why

1. **Boot as a courtroom, not a loader** (v0). A bundle is a *claim*; the
   court re-proves it or refuses. Tradeoff: boot always costs a replay;
   the payoff is that every stored artifact is honest by construction, and
   the 26 fail-closed rules (counted by the wave-66 decomposition, Task 66-d)
   are the courtroom's named verdicts.
2. **Reverse-actualized spec** (docs/REVERSE-ACTUALIZED-SPEC.md): the spec
   was written backward from working code, section by section, each with
   acceptance proofs. Tradeoff: the spec lags code moments; the payoff is
   zero spec-code drift and every section names its tests.
3. **Toy substrate as a disappearing stand-in** (v0 note; DESIGN.md §4
   Alternative A REJECTED). Growing the toy for chrono ops would have made
   the stand-in permanent and coupled two repos through the replay-critical
   evaluator. The adapter pattern (chronoOps.js) kept toyQuilt byte-identical.
4. **HMAC first, Ed25519 second** (v2 → v3). HMAC shipped the scale path fast
   (one shared secret, stdlib); v3 paid the complexity for attribution and
   rotation. The honest residual — a shared secret has no name — is recorded
   in v2 provenance rather than papered over.
5. **Double-entry for nesting and rewind** (v0/v1). Hosts stay safe because
   every organ debit has a host credit and every rewind emits exactly one
   compensating receipt with evidence; append-only means history is never
   rewritten, only superseded. Tradeoff: more receipt kinds; the payoff is
   that "undo" is auditable arithmetic, not deletion.
6. **Env-read keys + keyscan ritual** (fleet law post-incident). The cot-quilt
   incident (2026-10-01) showed an unsanitized exception string can leak a
   credential into a committed receipt; `scripts/keyscan.mjs` makes the
   pre-push scan a law, with output discipline that never prints matched
   values.
