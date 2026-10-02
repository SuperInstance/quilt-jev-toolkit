# quilt-jev-toolkit

> Small toolkit for using JEV (TypeSafe) as a Quilt canon oracle — and, since
> wave 63, home of the **Cell-Organ Snapshot & Boot protocol**: use a
> receipt-chain ledger to rewind, snapshot, and boot saved states of cells,
> groups of cells (organs), or entire quilts, as drop-ins that nest inside
> another program or quilt. v0 = custody (snapshot/boot/nest); v1 = the rewind
> family + write-side transactions (below); v2 = checkpoint signatures +
> partial-custody replay seeds (`--from-checkpoint`, bottom); §9 = the
> chrono-op adapter — **a sealed quilt-chrono sheet boots as an organ**
> (`bootChrono`, bottom).

JEV is a hosted oracle that answers yes/no, multiple choice, and
scored questions about content. It's deterministic (variance < 0.01
across runs), fast (~66ms/call), and robust to adversarial inputs.

This toolkit wraps JEV with a small `noul / choice / score` builder
API and adds utilities for canon-gating Quilt content.

---

## ORGAN BOOT v0 — what a zero-shot agent needs to know

An **organ** is a group of cells plus its full receipt-chain history, packaged
as a **bundle** `{ manifest, state, receipts }`. A snapshot is a *custody
claim*: content-addressed (sha256 of canonical state + every receipt hash).
Boot is the courtroom: the claim is either **proven by replay** or refused.
Full doctrine: [`docs/REVERSE-ACTUALIZED-SPEC.md`](docs/REVERSE-ACTUALIZED-SPEC.md).

### The 5 commands

```bash
# 0. run the proof suite (23 tests) and the end-to-end demo
npm test                      # node --test test/organ.test.mjs
npm run demo                  # snapshot → corrupt → fail-closed → boot → nest → re-snapshot

# 1. SNAPSHOT — quilt cells + ledger → verified bundle (content-addressed)
node -e '
import("./src/organ/snapshot.mjs").then(async ({ snapshot }) => {
  const { buildGreeterQuilt } = await import("./examples/greeter-organ.mjs");
  const q = buildGreeterQuilt();                      // 4 cells, 12 receipts
  const bundle = snapshot(q.cells, q.ledger, { name: "greeter-organ" });
  console.log(bundle.manifest.organId, bundle.manifest.manifestHash.slice(0, 16));
});'

# 2. BOOT (standalone) — verify chain-of-custody + replay == state, or fail closed
node -e '
import("./src/organ/boot.mjs").then(async ({ boot }) => {
  const { buildGreeterQuilt } = await import("./examples/greeter-organ.mjs");
  const { snapshot } = await import("./src/organ/snapshot.mjs");
  const q = buildGreeterQuilt();
  const organ = boot(snapshot(q.cells, q.ledger, { name: "greeter-organ" }));
  console.log(organ.cells.out.value);                 // "Ahoy, SuperInstance!"
});'

# 3. BOOT INTO A HOST QUILT — nesting envelope, cross-quilt receipts
#    boot(bundle, { host }) → organ.nest receipt in host ledger
#    organ.append(op)       → organ DEBIT + host CREDIT (double entry)

# 4. CONTINUE — append ops to a nested organ; every debit is credited host-side
#    organ.append({ type: "set", cellId: "subject", value: "organ" })
#    verifyDoubleEntry(host, organ) → { ok, creditsChecked }

# 5. RE-SNAPSHOT — the organ is portable again, identity intact
#    snapshotOrgan(organ) → bundle (same organId, full chain, supersedes pinned)
#    boot(that, { host: freshQuilt }) → wakes in a third quilt, hash-equal state
```

(1–2 are runnable one-liners; 3–5 are three lines each, shown as the demo runs
them in `examples/boot-demo.mjs`.)

### The invariants (v0)

- **I1 content addressing** — manifest + state + receipts are canonical-JSON,
  sha256-addressed; identical bytes = identical `manifestHash`; cell order is
  sorted so the hash is a pure function of content.
- **I2 chain of custody** — every receipt hash re-verifies on boot, from
  `GENESIS` or from a pinned `trustedCheckpoint {seq, hash}`. A range starting
  at seq > 0 with no checkpoint is *unowned history* → refuse.
- **I3 deterministic replay** — `boot == replay`: state is rebuilt by replaying
  the receipt range on empty cells and asserted hash-equal to the carried
  state. Receipts carry no wall-clock time; `seq` is time.
- **I4 the manifest is the custody claim** — `quilt.organ.manifest/v1`:
  cells(+hashes), edges, receiptRange, genesis anchor, state address,
  supersedes, self-hash.
- **I5 nesting without host breakage** — the organ keeps ITS OWN ledger across
  quilt boundaries; the host only receives pointer receipts
  (`organ.nest`, `organ.credit`), so host invariants are structurally safe and
  the host ledger still replays deterministically.

### The fail-closed rules

Boot throws `OrganBootError` (never partially boots) on: `SCHEMA_DRIFT`,
`MANIFEST_INVALID`, `STATE_HASH_MISMATCH`, `RECEIPT_HASH_MISMATCH`,
`CHAIN_GAP`, `CUSTODY_GAP`, `CUSTODY_CHECKPOINT_MISMATCH`,
`REPLAY_DIVERGENCE`, `REPLAY_INVALID_OP`. Nesting throws `NestError` on
`DUPLICATE_NEST`; the double-entry audit reports `DOUBLE_ENTRY_UNBALANCED /
_HASH_MISMATCH / _STATE_MISMATCH` and never auto-repairs.

Proofs: `test/organ.test.mjs` (23/23 v0; 34/34 with the v1 section; 44/44 with
the v2 section below) — including a self-consistent *forged*
chain (re-hashed by an attacker) that only replay can catch, and a forged host
credit caught by double-entry. Evidence receipt: `examples/receipts/boot-demo-receipt.json`.

v0 substrate note: the toolkit had no cells/ledger concept before this lane, so
`src/organ/toyQuilt.mjs` is the receipted stand-in quilt (4 op types, pure,
clock-free). When a real cells/ledger layer lands (quilt-upstream or here),
organ code moves onto it by adapting `quiltApply / applyOp / stateOf`.

---

## ORGAN BOOT v1 — the rewind family + write-side transactions

v1 adds three verbs on top of v0's snapshot/boot/nest. v0's law is carried over
untouched: **nothing is trusted, everything is re-proven** — the subject
(bundle or booted organ) is fully re-verified (chain + replay == carried state)
*before* any query, rewind, or write runs, so a rewind is never a forgery
laundromat for the tail it ignores.

- `stateAt(subject, seq)` — time-travel query, pure: the state as of receipt
  `seq`, hash-asserted against an independent prefix replay. Never mutates,
  never writes host receipts.
- `rewind(subject, toSeq)` — bundle form: a pure view `{ state, stateHash,
  provenance }` (input untouched). Organ form: destructive — the organ's ledger
  truncates to `toSeq`, cells are rebuilt by pure replay (byte-equal to a fresh
  boot of the truncated bundle), and if the organ is nested the host receives
  exactly ONE compensating receipt `{ type: "organ.rewind", organId, fromSeq,
  toSeq, stateHashAfter, rewound: [{creditSeq, creditHash, organSeq,
  debitHash}, ...] }` — the double-entry discipline applied backwards,
  append-only: the superseded credits stay in the host ledger, marked dead by
  the evidence list.
- `transact(bundle, ops)` — all ops or nothing. PREPARE stages every op on
  detached copies, each validated against the post-op state (first failure
  names `failedOp` + code; the input bundle is byte-untouched). COMMIT
  materializes the successor bundle exactly once (`supersedes` pinned, same
  organId) and self-verifies it through the boot courtroom — a committed bundle
  is one that would boot.

### The 5 commands

```bash
# 0. the proof suite (34 tests) and the v1 end-to-end demo
npm test                                    # 23 v0 + 11 v1
npm run demo:rewind                         # transact → atomicity → stateAt → rewind → compensating credit → fail-closed audit

# 1. STATE AT — time-travel query (pure; bundles and booted organs)
node -e '
import("./src/organ/rewind.mjs").then(async ({ stateAt }) => {
  const { buildGreeterQuilt } = await import("./examples/greeter-organ.mjs");
  const { snapshot } = await import("./src/organ/snapshot.mjs");
  const q = buildGreeterQuilt();
  const v = stateAt(snapshot(q.cells, q.ledger, { name: "greeter-organ" }), 5);
  console.log(v.seq, v.stateHash.slice(0, 16), v.provenance.count, v.state.cells.subject.value);
});'

# 2. REWIND — bundle form is a pure view; organ form is the real rewind
#    rewind(bundle, toSeq) → { state, stateHash, provenance }
#    rewind(organ,  toSeq) → + rewoundFrom, compensating (host receipt if credits are revoked)

# 3. TRANSACT — atomic multi-op write (input bundle byte-untouched on any failure)
#    transact(bundle, ops) → ok: { bundle, newReceipts, fromStateHash, toStateHash }
#                            fail: { ok:false, phase:"prepare", failedOp, code, detail }

# 4. REWIND PAST A NEST BOUNDARY — compensating entry, double-entry applied backwards
#    host ledger gains organ.rewind; verifyDoubleEntry(host, organ)
#      → { ok, creditsChecked, creditsRevoked, rewinds }   // nets to zero

# 5. CONTINUE + RE-SNAPSHOT — the organ appends from the rewound tip, custody unbroken
#    organ.append(op) → fresh debit + fresh host credit; snapshotOrgan(organ)
#    boot(snapshotOrgan(organ)) → hash-equal state in a fresh quilt
```

(1 is a runnable one-liner; 2–5 are the lines `examples/rewind-demo.mjs` runs,
each asserted by a demo stage with a committed evidence receipt at
`examples/receipts/rewind-v1-demo-receipt.json`.)

### The v1 proofs (11 new tests, all in `test/organ.test.mjs`)

- **rewind round-trip**: `rewind(bundle, 0)` reproduces the genesis state
  byte-identically; rewind to the pre-advance tip == the v0 snapshot's state
  hash; rewind to tip == carried state; a rewound organ's re-snapshot boots
  hash-equal in a fresh quilt.
- **transaction atomicity**: fail op 2 of 3 → `OP_APPLY_FAILED` at
  `failedOp: 1`, staged effects never leak, the bundle is byte-identical to
  before the transaction.
- **compensating credit**: rewinding a nested organ past its nest boundary
  emits one `organ.rewind` host receipt revoking exactly the post-nest
  credits; the host ledger still verifies; double-entry nets to zero; a
  partial rewind leaves the surviving credits pairing 1:1.
- **stateAt determinism**: same seq → same hash across independent builds and
  runs; pure on bundles and organs.
- **fail-closed**: forged rewind receipts are caught three ways (padded
  evidence → `DOUBLE_ENTRY_REWIND_INVALID` + `DOUBLE_ENTRY_HASH_MISMATCH`;
  bogus `stateHashAfter` → `DOUBLE_ENTRY_STATE_MISMATCH`; dangling evidence →
  `DOUBLE_ENTRY_HASH_MISMATCH`); bounds refuse `REWIND_TARGET_INVALID` /
  `REWIND_PAST_CUSTODY`; self-consistent forged chains refuse `stateAt`,
  `rewind`, AND `transact` with v0's `REPLAY_DIVERGENCE`.

Cross-feed: both v1 states (tip + rewound) are on the live fleet organ store —
`examples/receipts/rewind-v1-upload-receipt.json` (uploaded through the
receipted `quilt.organ.v1` dialect adapter; native-dialect refusal receipted as
the DIALECT_DRIFT finding, unification parked to lane 64-c).

---

## ORGAN BOOT v2 — checkpoint signatures + partial custody (`--from-checkpoint`)

v2 adds the scale path: mint a SIGNED checkpoint once (pay the genesis replay
once), then boot bundles that carry only the post-checkpoint receipts plus a
replay seed. The custody gap becomes **conditional** — legal exactly when an
HMAC-SHA256 signature under the verifier's key covers the boundary; unsigned
gaps still fail closed (`CUSTODY_GAP`, unchanged). Doctrine:
`docs/REVERSE-ACTUALIZED-SPEC.md` §8.

```bash
# 0. the proof suite (44 tests: 34 v0/v1 + 10 v2)
npm test                                    # node --test test/organ.test.mjs

# 1. MINT — verify the snapshot, replay the prefix ONCE, sign (manifestHash, chainTip, seq)
node -e '
Promise.all([import("./src/organ/checkpoint.mjs"), import("./src/organ/snapshot.mjs"), import("./examples/greeter-organ.mjs")])
  .then(async ([{ signCheckpoint }, { snapshot }, { buildGreeterQuilt }]) => {
    const q = buildGreeterQuilt();
    const cp = signCheckpoint(snapshot(q.cells, q.ledger, { name: "greeter-organ" }), 7, "fleet-key");
    console.log(cp.seq, cp.alg, cp.manifestHash.slice(0, 16)); // 7 HMAC-SHA256 <prefix manifestHash>
  });'

# 2. CARVE — the partial-custody bundle: receipts [checkpointSeq+1..tip] + seed + signed checkpoint
#    carvePartialCustody(bundle, cp) → { manifest, state, receipts, seed, checkpoint }

# 3. BOOT --from-checkpoint — verify signature → replay from the anchored seed → assert == state
#    boot(partial, { checkpointKey: "fleet-key" })
#    → organ.custody = { signedAt: {seq, hash, manifestHash, alg}, verifiedRange, seed }
#    Fail-closed: CHECKPOINT_SIGNATURE_INVALID (forged/wrong key), CHECKPOINT_SEED_MISMATCH
#    (seed tamper), CHECKPOINT_ANCHOR_MISMATCH (swapped prefix manifest),
#    CHECKPOINT_SEQ_BEYOND_RECEIPTS, CHECKPOINT_SIGNATURE_REQUIRED (no key),
#    CUSTODY_GAP (unsigned gap — unchanged v0 law)

# 4. REWIND --from-checkpoint — down to the custody boundary only, hash-equal to
#    the full bundle's answers; below the boundary is unowned history:
#    rewind(organ, seq < boundary) → REWIND_PAST_CUSTODY (names the checkpoint)

# 5. CONTINUE + RE-SNAPSHOT — append/transact extend the same chain and carry the
#    anchor forward; snapshotOrgan(organ) boots again under the same key
```

Scale property: booting a 10-million-receipt organ costs O(tail), not
O(history) — genesis is replayed once at checkpoint time, never at boot. The
signature anchors the seed through two content-address hops
(`sig → manifestHash → prefix manifest → seed state`); the only trust input is
the key. Honest scope (§8.3): the anchor vouches for the prefix;
post-checkpoint custody is the v0 law (hash chain + replay == state). Ed25519
(asymmetric "who vouches") is the v3 path.

---

## CHRONO BOOT — a time-traveling sheet boots as an organ (spec §9)

quilt-chrono's sealed sheets — ledger + `<ledger>.chain.jsonl` sidecar +
`seal()` — are now **boot()-able organs**. `src/organ/chronoOps.js` adapts
the chrono chain into organ receipts (spec §9: reads → no-op witness
receipts, writes → cell sets, pushes → the (witness, set) pair; every
decision named and tested), and `bootChrono` runs the full courtroom: seal
signature → anchor manifest → sidecar chain verify → boundary pin → mapping →
replay == the SIGNED state → the REAL `boot()`.

```bash
# 0. the proof suite (60 tests: 44 v0–v2 + 16 chrono/§9)
npm test                                    # node --test test/organ.test.mjs tests/chrono-interop.test.mjs

# 1. BOOT A SEALED CHRONO SHEET (bundle = { links: <chain.jsonl links>, checkpoint: <seal> })
node -e '
import("./src/organ/chronoOps.js").then(async ({ bootChrono }) => {
  const f = JSON.parse((await import("node:fs")).readFileSync("./tests/fixtures/chrono-fixture.json", "utf8"));
  const organ = bootChrono({ links: f.links, checkpoint: f.checkpoint }, { key: f.key });
  console.log(organ.manifest.organId, JSON.stringify(organ.cells));
});'
# → chrono-demo@ef28377edd1b07fc {"sensor.temp":{"kind":"value","value":22.1},"sink.display":{"kind":"value","value":22.4}}

# 2. TIME TRAVEL — the organ verbs work on the chrono-born sheet
#    stateAt(organ, t) / rewind(organ, t) == the chrono write-fold at t

# 3. CUSTODY PROVENANCE — organ.custody = { kind: "chrono-seal", signedAt,
#    sealedRange, verifiedRange, chainTip }
#    Fail-closed: CHECKPOINT_SIGNATURE_INVALID (forged/wrong key),
#    CHECKPOINT_SEQ_BEYOND_RECEIPTS (truncated sidecar),
#    CUSTODY_CHECKPOINT_MISMATCH (wrong chain), CHECKPOINT_ANCHOR_MISMATCH
#    (swapped anchor), REPLAY_DIVERGENCE (stale signed manifest),
#    CHRONO_OP_UNMAPPABLE / CHRONO_FLOW_UNPAIRED (semantic refusals)

# 4. REGENERATE THE FIXTURE (needs ../quilt-chrono present; test-only key)
npm run fixture:chrono                       # scripts/vendor-chrono-fixture.mjs
```

The live interop test (`LIVE interop` in `tests/chrono-interop.test.mjs`)
builds a sheet with chrono's own `Ledger`, seals it with chrono's own
`seal()`, boots it here, and asserts equality with chrono's own
`verifyCustody` — skip-if-absent, so this repo stays standalone. Doctrine:
`docs/REVERSE-ACTUALIZED-SPEC.md` §9.

---

## Quick start (JEV oracle)


```bash
export TYPESAFE_API_KEY=apikey_...   # legacy TYPESAFEAI_KEY also accepted
python3 jev_client.py "the earth is round" '{"x": {"type": "noul", "instructions": "Is this true?"}}'
```

Or in Python:

```python
from jev_client import ask, noul, choice, score

result = ask(
    "Quilt cells form communities that grow and die like organisms.",
    {
        "is_canon": noul("Is this canon-worthy?"),
        "domain": choice("Which domain?", {"biology": "...", "cs": "..."}),
        "depth": score("Rate depth", ["low", "moderate", "high", "extreme"]),
    }
)
print(result["answers"])
```

## Discovery results (Sept 24, 2026)

Rounds run so far:

| Round | Topic | Finding |
|-------|-------|---------|
| 1 | Boundary tests | JEV handles 1-char, 5000-char, unicode; 0.3s per call |
| 2 | Factual sweep | 19/20 = 95% accuracy on basic truths |
| 3 | Myth-busting | 12/12 = 100% on common misconceptions |
| 4 | Cross-model | jev-latest ≈ jev-preview (same answers) |
| 5 | Quilt README canon-gate | QULT.md: is_canon=0.73, is_fractal=0.98 |
| 6 | TLDR_MANY_LANGUAGES | is_polyformal=0.95, languages_count=2.98 |
| 7 | Adversarial | 7/7 on prompt injection / leading questions |
| 8 | Scale | 50 parallel calls in 3.3s (66ms/call) |
| 9 | Determinism | p range 0.980-0.990 over 10 runs |

## Files

- `jev_client.py` — minimal JEV client (noul / choice / score builders)
- `canon_gate.py` — score Quilt content for canon promotion
- `discovery_log.md` — round-by-round findings

## Why JEV is one signal, not the only signal

JEV is fast and well-calibrated, but it's still an LLM oracle. It can
hallucinate (see Round 2 — "humans have 5 senses" returned 0.49,
which is technically right — humans have more than 5 senses — but
the conventional answer is 5).

Use JEV as **one canary** in a multi-signal canon gate:
- JEV score
- Byte-exact polyformality (across 6 substrates)
- Multi-model consensus (JEV + ZAI + DeepSeek agreeing)
- Human review for borderline cases

## Gotchas (re-confirmed)

- `criteria` is required for `score` and `choice` questions (a list
  of strings for score, a dict of {name: description} for choice)
- `noul` questions can have `criteria` (true/false descriptions) but
  it's optional
- JEV returns `usage.input_tokens` and `usage.output_tokens` — use
  them to budget
- The model name in response is `jev-1.13.0` (not the alias
  `jev-latest` you sent)
- For choice questions, `confidence` can be low even when the
  `choice` is clearly correct — check the `probabilities` dict
