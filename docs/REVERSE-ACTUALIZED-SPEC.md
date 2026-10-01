# REVERSE-ACTUALIZED SPEC — Cell-Organ Snapshot & Boot

Lane 63-c · wave 63 · status: **v0 implemented in this repo** (`src/organ/`, tested, fail-closed).

Method: imagine the perfect far-ahead end-state **in present tense** (§1), then derive
backward the minimal v0 that is true *today* (§2–§6). Nothing in §2+ is aspiration;
every invariant listed has a passing test or a fail-closed refusal behind it.

---

## 1. The far-ahead image (present tense, as experienced)

Any agent, anywhere, on any substrate, types:

```
boot organ://fleet/greeter-organ@9f2c
```

and a verified organ **wakes up inside their program or quilt**. Not a copy of a
file — an *organ*: a group of cells with its full receipted history intact, its
internal ledger still appending, its identity continuous with every prior
incarnation. The boot is **verified**: every receipt hash re-checked from genesis
(or from a trusted checkpoint), the claimed state **re-derived by replay** and
asserted equal to the carried state. If one byte anywhere disagrees, the organ
does not wake — the boot fails closed, loudly, with a code saying exactly which
invariant broke.

Organs **compose**. An organ from quilt A nests inside quilt B; its internal
ledger continues appending *cross-quilt receipts* — every organ debit is matched
by a host credit, double-entry style, so neither ledger's invariants bend. Nest
the host, and the organ rides inside the host's snapshot as a first-class part.
Rewind the host, and the organ rewinds with it, to any receipt boundary, exactly.
Organs graft, split, hibernate, and migrate between fleets the way cells migrate
between bodies — and every transfer leaves a receipt chain that any third party
can audit from genesis.

In that world "state" is never asserted; it is always **proven** — the trailing
edge of a hash-linked causal history. Snapshots are not backups; they are
*custody claims*, and boot is the courtroom where the claim is either proven or
thrown out.

---

## 2. Derivation backward: the v0 invariants

Working backward from §1, the v0 must make each future capability *representable*
without yet implementing it. Five invariants do that. (I1–I3 are implemented and
tested here; I4–I5 are represented and receipted.)

- **I1 — Content-addressed snapshots.** A snapshot is addressed by the sha256 of
  its canonicalized state plus the sha256-receipt-chain range that produced it.
  Two snapshots with identical bytes are the *same object*; a snapshot that
  cannot recompute its own hashes is not a snapshot.
- **I2 — Chain-of-custody verification on boot.** Boot re-verifies every receipt
  hash, from genesis **or** from a trusted checkpoint pinned in the manifest. An
  unanchored prefix (range starts at seq > 0 with no checkpoint) is unverifiable
  custody → refuse. v0 trusts exactly two anchors: GENESIS and an explicit
  checkpoint `{seq, hash}`. Nothing else is trust.
- **I3 — Deterministic replay guarantee.** `boot == replay` : the boot reconstructs
  state by replaying the receipt range through the deterministic op evaluator on
  empty cells, and **asserts the replay equals the carried state** (canonical
  sha256 over both). Receipts carry no wall-clock time — `seq` is time. All
  JSON is canonicalized (sorted keys, no float ambiguity). Replay divergence is
  a hard stop, not a warning.
- **I4 — Organ manifest as custody claim (format).** The manifest is the single
  portable document: cells (+ per-cell state hash), edges, receipt range, custody
  anchor, state address, schema version, self-hash. v0 freezes this format
  (§3); future formats extend via `schemaVersion` with fail-closed drift.
- **I5 — Nesting envelope without host breakage.** A nested organ keeps its own
  ledger (custody continuity — its hash chain never restarts), while the host
  ledger receives **credit receipts** pointing at organ **debit receipts**
  (§5). The host's own hash chain is never interleaved with organ internals, so
  host invariants (contiguous hash-linked receipts) are structurally safe.

Explicitly *out* of v0 (receipted as future work): rewinding a host to a
pre-nest boundary (represented: the nest receipt is a normal host receipt);
signatures on checkpoints (checkpoint is a pinned hash, not a PKI claim);
mirrored read-only views of organ cells inside host cells; organ split/merge;
canonical binary encoding (v0 is canonical JSON).

---

## 3. Manifest format v0 (`quilt.organ.manifest/v1`)

```jsonc
{
  "schema":         "quilt.organ.manifest",
  "schemaVersion":  1,
  "organId":        "greeter-organ@1a2b3c4d5e6f7a8b",   // name@16-hex, minted once, carried forward
  "name":           "greeter-organ",
  "cells":          [ { "id": "greeting", "kind": "value", "stateHash": "<sha256(id,kind,value)>" } ],
  "edges":          [ { "from": "greeting", "to": "out" } ],  // v0: data-flow, endpoints must be known cells
  "receiptRange":   { "start": 0, "end": 11, "count": 12 },   // inclusive, count == end-start+1
  "genesis":        { "seq": 0, "prevHash": "GENESIS" },      // custody anchor; prev of first carried receipt
  "state":          { "cellsSha256": "<sha256(canonical cells)>" },
  "supersedes":     null,                                     // prior manifestHash, if this is a re-snapshot
  "manifestHash":   "<sha256(canonical manifest without this field)>"
}
```

Canonicalization: JSON with recursively sorted object keys, UTF-8, no
whitespace; `undefined`/functions/NaN refuse to serialize (throw). A bundle is
`{ manifest, state: { cells }, receipts }` — exactly the bytes needed to prove
its own custody.

---

## 4. Failure modes → fail-closed rules (v0 law)

| Code | Failure mode | Detection | Fail-closed rule |
|------|--------------|-----------|------------------|
| `SCHEMA_DRIFT` | unknown `schemaVersion` / wrong `schema` | manifest validation | refuse boot; never "best-effort parse" |
| `MANIFEST_INVALID` | missing/malformed fields, bad hex, edge to unknown cell, self-hash mismatch | manifest validation | refuse boot |
| `STATE_HASH_MISMATCH` | snapshot state bytes altered after signing | recompute `cellsSha256` / per-cell hashes | refuse boot |
| `RECEIPT_HASH_MISMATCH` | any carried receipt's hash doesn't recompute | chain verify | refuse boot |
| `CHAIN_GAP` | seq not contiguous; `prev` doesn't equal previous hash; range/count disagreement | chain verify | refuse boot (a gap is a missing page of custody) |
| `CUSTODY_GAP` | range starts at seq > 0 with no `trustedCheckpoint` | custody check | refuse boot — an unverifiable prefix is unowned history |
| `CUSTODY_CHECKPOINT_MISMATCH` | checkpoint `{seq,hash}` doesn't pin the first receipt's parent | custody check | refuse boot |
| `REPLAY_DIVERGENCE` | internally-consistent forged chain replays to different state than carried | replay + assert | refuse boot — this is the invariant that catches forgeries that re-hash themselves |
| `REPLAY_INVALID_OP` | an op is undeterminable or references missing cells | replay | refuse boot |
| `DUPLICATE_NEST` | same `manifestHash` nested twice into one host | nest | refuse nest |
| `DOUBLE_ENTRY_*` | organ debit without host credit (or vice versa), hash mismatch, stale state hash | `verifyDoubleEntry` | report fail-closed (v0: verify-only, never auto-repair) |

**Boot never partially succeeds.** The organ instance is constructed only after
every check passes; a failed boot returns nothing but the error.

---

## 5. Nesting envelope (how a nested organ's ledger appends without breaking host invariants)

- The organ's ledger is **its own** hash chain; nesting does not merge chains.
  Continuing ops append to the organ chain (debit) *and* to the host chain
  (credit), so an organ that lived in quilt A and now lives in quilt B has one
  unbroken causal ledger crossing the quilt boundary — §1's "cross-quilt receipts".
- Host credit receipt: `{ type: "organ.credit", organId, organSeq, debitHash,
  stateHashAfter }` — a pure pointer + attestation. It adds no organ state to the
  host, so it cannot violate host invariants; the host chain stays contiguous.
- Double-entry law: every organ debit after nesting has exactly one host credit,
  and every host credit resolves to a real organ debit whose replayed state hash
  matches `stateHashAfter`.
- The host's `organ.nest` receipt pins `{ organId, manifestHash, tipHash,
  organSeq }` — the custody moment. Re-snapshot of a nested organ re-uses the
  organ's own chain from genesis, so the exported bundle is portable *again*.

---

## 6. v0 acceptance (all proven by `node --test test/organ.test.mjs`)

1. Happy-path boot: snapshot → boot in a fresh process-object → state + organId equal.
2. Tamper: flip one byte of state / one receipt payload / one manifest field → boot fails closed with the exact code (three independent cases).
3. Chain gap: delete one middle receipt → `CHAIN_GAP`, fail closed.
4. Replay divergence: a re-hashed (self-consistent) forged chain with stale state → `REPLAY_DIVERGENCE`, fail closed.
5. Nesting round-trip: snapshot → boot into fresh host → continue 3 ops (debits+credits) → re-snapshot → boot in a second fresh host → state hash identical before/after; double-entry verified; credit tamper detected.
6. Untrusted prefix without checkpoint → `CUSTODY_GAP`; with pinned checkpoint → boot succeeds.
