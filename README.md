# quilt-jev-toolkit

> Small toolkit for using JEV (TypeSafe) as a Quilt canon oracle — and, since
> wave 63, home of the **Cell-Organ Snapshot & Boot protocol (v0)**: use a
> receipt-chain ledger to rewind, snapshot, and boot saved states of cells,
> groups of cells (organs), or entire quilts, as drop-ins that nest inside
> another program or quilt.

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

Proofs: `test/organ.test.mjs` (23/23) — including a self-consistent *forged*
chain (re-hashed by an attacker) that only replay can catch, and a forged host
credit caught by double-entry. Evidence receipt: `examples/receipts/boot-demo-receipt.json`.

v0 substrate note: the toolkit had no cells/ledger concept before this lane, so
`src/organ/toyQuilt.mjs` is the receipted stand-in quilt (4 op types, pure,
clock-free). When a real cells/ledger layer lands (quilt-upstream or here),
organ code moves onto it by adapting `quiltApply / applyOp / stateOf`.

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
