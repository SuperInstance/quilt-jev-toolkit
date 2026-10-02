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

---

## 7. v1 — the rewind family + write-side transactions (lane 64-a)

§1's far-ahead image has a first verb: an agent doesn't just boot an organ —
it **rewinds** it. v1 derives backward into three implemented verbs
(`src/organ/rewind.mjs`), with the v0 courtroom (§2–§4) carried over untouched:
the subject is fully re-verified — chain verify + replay == carried state —
*before* any verb runs, whether the subject is a bundle or a booted organ.
A rewind cannot become a forgery laundromat for the tail it ignores.

### 7.1 The three verbs

- `stateAt(subject, seq)` — **time-travel query, pure.** The state as of
  receipt `seq` (inclusive prefix replay), returned with provenance
  `{ start, end, count, tipHash, carriedRange }`. Never mutates; never writes
  host receipts. Works on bundles and booted organs.
- `rewind(subject, toSeq)` — **bundle form: pure view** (same shape as
  `stateAt`; the input bundle is untouched). **Organ form: the destructive
  rewind** — the organ's ledger truncates to `toSeq` and its cells are rebuilt
  by pure replay, byte-equal to what a fresh boot of the toSeq-truncated bundle
  would produce; the organ then continues appending from the rewound tip
  (same hash chain, custody unbroken).
- `transact(bundle, ops)` — **write-side transaction, all ops or nothing.**
  PREPARE stages every op on detached copies, each validated against the
  post-op state of the ops before it (the deterministic evaluator is the
  validator); the first failure returns `{ ok:false, phase:"prepare",
  failedOp, code, detail }` and the input bundle is byte-untouched. COMMIT
  materializes the successor bundle exactly once via `snapshot()` — same
  organId, `supersedes` pinned to the input manifestHash — and self-verifies it
  through `verifyBundle` before returning. No partially-extended bundle ever
  exists; an empty transaction is an honest no-op returning the identical
  custody claim.

### 7.2 The compensating receipt — double-entry applied backwards

Rewinding a nested organ past its nest boundary would, in v0's law, strand the
host credits for the rewound window. v1 closes that hole with ONE host
receipt, the exact reverse of `nest`'s debit/credit pair:

```
{ type: "organ.rewind", organId, fromSeq, toSeq, stateHashAfter,
  rewound: [ { creditSeq, creditHash, organSeq, debitHash }, ... ] }
```

The revocation law (all enforced by `verifyDoubleEntry`, which is now
rewind-aware and returns `{ ok, errors, creditsChecked, creditsRevoked,
rewinds }`):

- **Append-only, evidence-based revocation.** Nothing is ever erased: the
  superseded credits stay in the host ledger, marked dead by the rewind
  receipt's evidence list. A credit is live unless some `organ.rewind` receipt
  (same organId) lists it; credits minted after the rewind are never listed and
  so stay live.
- **Self-audit.** Every rewind receipt must name a `toSeq` the organ's carried
  ledger actually contains, its `stateHashAfter` must equal the organ's
  replayed state at `toSeq`, and every `rewound[]` entry must match a real host
  credit (seq, hash, organSeq, debitHash) — a padded, dangling, or
  doubly-listed evidence entry fails closed.
- **Temporal form.** An honest rewinder lists only credits that already
  existed: a listed `creditSeq` must precede the rewind receipt's own host seq.
  This also makes self-consistent padding structurally impossible — the
  evidence carries each credit's hash, but that hash depends on the rewind
  receipt's hash (its `prev`), which depends on the evidence.
- **Pairing law.** Every LIVE credit must resolve to a debit the organ's
  current carried ledger holds (same seq, same debitHash), and every carried
  post-nest debit must be covered by a live credit — after a rewind the
  double-entry nets to zero (0 live / N revoked), and post-rewind appends pair
  1:1 again.

### 7.3 New fail-closed codes (v1, all proven in the test suite)

| Code | Failure mode | Fail-closed rule |
|------|--------------|------------------|
| `REWIND_TARGET_INVALID` | non-integer / beyond-tip `toSeq`; subject neither bundle nor organ | refuse the verb |
| `REWIND_PAST_CUSTODY` | `toSeq` before the carried range start | refuse — a prefix the subject does not carry is unowned history (checkpoint custody starts at `genesis.seq`) |
| `TRANSACTION_INVALID` | `transact` on a non-array `ops`, or on a booted organ (organ-granularity transactions are parked) | refuse |
| `OP_MALFORMED` / `OP_APPLY_FAILED` | a staged op is not a plain object / refuses against post-op state | return `{ ok:false, failedOp, code }`; input byte-untouched |
| `STATE_UNSERIALIZABLE` | staged post-op state has no canonical form | fail the transaction in prepare |
| `DOUBLE_ENTRY_REWIND_INVALID` | rewind receipt with bad/missing `rewound[]`, non-preceding or duplicated evidence | report fail-closed |
| `DOUBLE_ENTRY_STATE_MISMATCH` / `_HASH_MISMATCH` / `_UNBALANCED` | v0 codes, now rewind-aware | report fail-closed |

v1 acceptance (proven by `node --test test/organ.test.mjs`, 34/34): rewind
round-trip byte-identical to genesis; `stateAt` == independent prefix replay,
deterministic across independent builds, pure on both subject kinds; rewind
past a nest boundary nets double-entry to zero with the host ledger still
verifying; partial rewind keeps surviving credits pairing 1:1; re-snapshot of
a rewound organ boots hash-equal; atomicity (op 2 of 3 fails → bundle
byte-identical); forged rewind receipts caught three ways; bounds refused;
self-consistent forged chains refuse `stateAt`, `rewind`, and `transact` with
`REPLAY_DIVERGENCE`. End-to-end demo: `examples/rewind-demo.mjs`
(`npm run demo:rewind`), evidence receipt
`examples/receipts/rewind-v1-demo-receipt.json`.

### 7.4 Now-covered vs parked

**Now-covered (v1):** host-ledger rewind across nest boundaries with
compensating credits (the cross-feed demand signal from the wave-63 coverage
table), all-or-nothing write-side transactions, time-travel queries with
provenance, custody-continuous truncation + continuation, and rewind-aware
double-entry auditing.

**Parked (receipted, in demand order):**

- **Checkpoint signatures / PKI** — ~~`trustedCheckpoint` is still an unpinned
  `{seq, hash}` pair; signatures (who vouches for the anchor) are
  unimplemented~~ **DELIVERED in v2 (§8)** — HMAC-SHA256 over
  `(manifestHash, chainTip, seq)`; asymmetric PKI ~~remains parked (§8.5)~~
  **DELIVERED in v3 (§10)** — Ed25519 checkpoints with named signers.
- **Organ split / merge** — one organ id splitting into two chains (or two
  merging); the rewind primitive is the substrate, the identity law is open.
- **Partial-custody replay seeds** — ~~replay still starts from empty cells
  (v0 law); a carried mid-chain seed state (replay from a verified snapshot at
  seq k) is parked~~ **DELIVERED in v2 (§8)** — the seed is legal exactly when
  a signed checkpoint anchors it.
- **Canonical binary encoding** — receipts/state are canonical JSON; a binary
  framing for large organs is parked.
- **Organ-granularity transactions** — `transact()` writes bundles; a nested
  organ's host-coupled transaction (debit+credit+rewind as one atomic host
  write) is parked.
- **Concurrent multi-organ hosts** — single-writer assumption unchanged from v0.
- **Dialect unification** — the fleet's organ store speaks `quilt.organ.v1`,
  the toolkit `quilt.organ.manifest/v1` (same canon law, different field
  layouts; the upload adapter + DIALECT_DRIFT finding are receipted in
  `examples/receipts/rewind-v1-upload-receipt.json`); unification is lane 64-c's.


---

## 8. v2 — checkpoint signatures + partial-custody replay seeds (lane 65-b)

§7.4's top parked item, derived backward into two implemented properties. The
far-ahead image needs a scale path: an organ with millions of receipts must
boot **without replaying genesis** — and the custody gap that v0 refused must
become legal under exactly one condition.

### 8.1 The signed checkpoint (`src/organ/checkpoint.mjs` + boot.mjs)

Minting (`signCheckpoint(bundle, seq, key)`) replays the prefix ONCE, at
checkpoint time, snapshots it, and signs the triple with HMAC-SHA256 under the
minter's key (Ed25519 is the v3 path; unknown algorithms refuse):

```
{ schema: "quilt.organ.checkpoint", schemaVersion: 1, alg: "HMAC-SHA256",
  seq: <boundary — last receipt covered>,
  hash: <receipt seq's hash = chainTip at the boundary>,
  manifestHash: <the prefix snapshot's manifestHash>,
  sig: <HMAC-SHA256(key, canonical({hash, manifestHash, seq}))>,
  manifest: <the prefix snapshot's manifest — unsigned, but content-addressed
             to the signed manifestHash> }
```

The signature anchors the replay SEED (the state at `seq`) through two
content-address hops: `sig → manifestHash → prefix manifest → seed state
hash`. The only trust input is the key; everything else is re-derived.

Carving (`carvePartialCustody(bundle, checkpoint)`) is keyless and mechanical:
it re-derives the prefix manifest from the verified full bundle, refuses a
checkpoint that does not describe this bundle's prefix exactly
(`CHECKPOINT_ANCHOR_MISMATCH`), and produces the partial bundle — receipts
`[seq+1..tip]` only, plus `seed: {seq, cells}` and the signed checkpoint.

### 8.2 Partial custody boot — the gap becomes CONDITIONAL

`boot(partial, { checkpointKey })` runs the v0 courtroom with one new branch
(§4's step 4): the bundle carries a replay seed ⇒ the prefix is not carried ⇒
the gap is legal **only if** a valid signature covers the boundary. The seed
replaces genesis as the replay floor: `replay(seed, receipts[seq+1..tip]) ==
manifest.state.cellsSha256` or no boot. The organ wakes carrying its custody
provenance:

```
organ.custody = { kind: "signed-checkpoint",
                  signedAt: {seq, hash, manifestHash, alg},
                  verifiedRange: {start, end},       // what replay actually verified
                  seed: {seq, cells, stateHash} }    // the replay floor, retained
```

`stateAt` / `rewind` become seed-aware on both subject kinds: prefix queries
answer **hash-equal to the full bundle's answers** above the floor; below the
floor — even to the checkpoint seq itself — is unowned history
(`REWIND_PAST_CUSTODY`, naming the checkpoint boundary). `transact` and
`snapshotOrgan` carry the seed + anchor forward, so a partial-custody lineage
stays bootable under the same key. Double-entry auditing replays
seed-aware too.

### 8.3 New fail-closed codes (v2, all proven in the test suite)

| Code | Failure mode | Fail-closed rule |
|------|--------------|------------------|
| `CHECKPOINT_SIGNATURE_REQUIRED` | seed present, no usable key (or no usable signed checkpoint to verify) | refuse boot — the gap boundary must be signature-covered |
| `CHECKPOINT_MALFORMED` | checkpoint doc fails structure (wrong schema/alg/version, missing fields, bad hex, bare unsigned `{seq,hash}` pair) | refuse boot — Ed25519 and anything else unknown is a v3 refusal, not a fallback |
| `CHECKPOINT_SIGNATURE_INVALID` | HMAC does not verify: forged sig, tampered signed fields, wrong key | refuse boot |
| `CHECKPOINT_SEQ_BEYOND_RECEIPTS` | checkpoint anchors a seq beyond the carried receipts | refuse boot — no post-checkpoint receipt exists to verify against it |
| `CUSTODY_CHECKPOINT_MISMATCH` | (v0 code, now also v2) genuine checkpoint, wrong chain/boundary | refuse boot |
| `CHECKPOINT_ANCHOR_MISMATCH` | the carried prefix manifest does not re-hash to the SIGNED manifestHash (swapped/tampered anchor; carve refuses the same way) | refuse boot |
| `CHECKPOINT_SEED_MISMATCH` | carried seed's state ≠ the signature-anchored prefix state (seed tamper) | refuse boot |
| `CHECKPOINT_SEQ_OUT_OF_RANGE` / `CHECKPOINT_MINT_INVALID` | mint/carve-side: boundary outside the range, carving at the tip (no tail would remain), minting from a partial-custody source | refuse the operation |

Unsigned gaps stay fail-closed exactly as in v0/v1: seed with no checkpoint at
all → `CUSTODY_GAP`; a full-custody bundle that stuffs a seed in →
`MANIFEST_INVALID` (contradictory custody claim).

**Honest scope of the anchor:** the signature vouches for the PREFIX — the
state at `seq`, the boundary receipt hash, the organ identity. Post-checkpoint
custody remains the v0 law (hash-linked receipts + replay == carried state);
a fully re-hashed post-checkpoint history is a different fork, not a detectable
forgery, exactly as a fully re-hashed genesis-to-tip bundle was in v0. A later
checkpoint tightens the window further.

### 8.4 v2 acceptance (proven by `node --test test/organ.test.mjs`, 44/44)

1. Signed checkpoint round-trip: sign → verify → carve → partial boot ==
   full boot byte-for-byte; provenance `{signedAt, verifiedRange}` carried;
   the ledger continues the same hash chain from the carried tip.
2. Structural no-genesis-replay proof: the first carried receipt cannot apply
   to empty cells, yet every `stateAt`/`rewind` answer is hash-equal to the
   full bundle's.
3. Unsigned gap still rejected (`CUSTODY_GAP`, `CHECKPOINT_MALFORMED` for a
   bare pair, `CHECKPOINT_SIGNATURE_REQUIRED` without a key).
4. Forgery: flipped sig / tampered signed fields / wrong key →
   `CHECKPOINT_SIGNATURE_INVALID` (and carve independently refuses the
   boundary tamper).
5. Post-checkpoint tamper: receipt tamper → `RECEIPT_HASH_MISMATCH`; seed
   tamper → `CHECKPOINT_SEED_MISMATCH`; swapped anchor →
   `CHECKPOINT_ANCHOR_MISMATCH`; self-consistent tail forgery with a stale
   claim → `REPLAY_DIVERGENCE`.
6. Degenerate checkpoint-at-tip: legal to mint and verify; the full bundle
   boots with it; carving at the tip refuses (`CHECKPOINT_SEQ_OUT_OF_RANGE`).
7. Rewind from partial custody works down to the custody boundary only;
   below it refuses with `REWIND_PAST_CUSTODY` naming the checkpoint; a
   rewound partial-custody organ re-snapshots and boots under the same key.
8. `transact` and nesting (`verifyDoubleEntry`) are seed-aware; atomicity
   unchanged.

### 8.5 Now-covered vs parked

**Now-covered (v2):** checkpoint signatures (HMAC-SHA256 over
`(manifestHash, chainTip, seq)`, key provided at checkpoint time), boot from a
trusted checkpoint without the genesis chain, partial-custody replay seeds
(the v0 empty-cells replay law is now conditional on signed custody),
seed-aware time-travel/rewind/transactions/double-entry, and custody
provenance carried on the booted organ.

**Parked (in demand order):**

- **Ed25519 / real PKI** — ~~HMAC is symmetric: verifier and minter share the
  key. Asymmetric signatures (who vouches) + key rotation + multi-checkpoint
  chains are the v3 path; `CHECKPOINT_MALFORMED` already refuses unknown algs
  so the format can grow without drift.~~ **DELIVERED in v3 (§10)** — Ed25519
  checkpoints (`signCheckpointEd25519` / `verifyCheckpointEd25519`), named
  signers, and rotation chains; what remains parked there is PKI
  infrastructure (issuance/revocation), not the signature layer.
- **Organ split / merge** — one organ id splitting into two chains (or two
  merging); the rewind primitive is the substrate, the identity law is open.
- **Canonical binary encoding** — receipts/state are canonical JSON; a binary
  framing for large organs is parked.
- **Organ-granularity transactions** — `transact()` writes bundles; a nested
  organ's host-coupled transaction (debit+credit+rewind as one atomic host
  write) is parked.
- **Concurrent multi-organ hosts** — single-writer assumption unchanged from
  v0.
- **Dialect unification** — the fleet's organ store speaks `quilt.organ.v1`,
  the toolkit `quilt.organ.manifest/v1`; unification is lane 64-c's (see
  §7.4).


---

## 9. v3-adjacent, v2-native — the chrono-op adapter: a time-traveling sheet boots as an organ (wave-68, lane 68-a)

§1's image says any agent can boot a saved state that time-travels.
quilt-chrono (wave-66/67) built the substrate side: a jsonl ledger of
read/write entries, push/tide flows, and — lane 67-a — a **seal** that is a
BYTE-EXACT `quilt.organ.checkpoint` over a hash-chain sidecar whose links are
organ receipts (`{seq, op: <the chrono entry verbatim>, prev, hash}`).
67-a's hand-off note said an organ-side adapter "would make snapshot+seal+
sidecar a fully boot()-able organ bundle". This section is that adapter,
landed where the spec lives: `src/organ/chronoOps.js`, two functions:

```
mapChronoChain(links)                  → { receipts, cells }   // the bridge
bootChrono({ links, checkpoint }, { key }) → organ             // the courtroom
```

quilt-chrono stays read-only and standalone (zero runtime imports across
repos — the 67-a law). Everything here is built from THIS repo's primitives
(`verifySignedCheckpoint`, `verifyChain`, `validateManifest`,
`computeManifestHash`, `makeReceipt`, `snapshot`, `boot`); equivalence with
chrono's own `verifyCustody` is a TEST (`tests/chrono-interop.test.mjs`,
skip-if-absent) plus a committed fixture generated BY chrono's seal
(`tests/fixtures/chrono-fixture.json`, provenance in the file).

### 9.1 The mapping (every decision has a name and a test)

A chrono entry is `{seq, ts_utc, op: "read"|"write", cell, value, by, cause,
pushed, flow_id, edge, corrects}`. The organ op vocabulary is
`{init, set, render}` plus the `organ.*` bookkeeping no-op envelope. The
translation is entry-by-entry and 1:1 (link i → receipt i; seqs stay aligned):

| chrono | organ receipt op | reason (named) |
|--------|------------------|----------------|
| `read` | `{type: "organ.chrono.read", cellId, witness, by, cause, chrono: {seq, hash}}` — **no-op** | **R1.** Organ law: cells change only through cell ops; chrono's own `cellsAt()` agrees ("reads are observations, not transitions"). But the sidecar is sealed 1:1 — a skipped entry would desync the seq binding and silently drop ledger content — so the read maps to a receipt that changes no cells, riding the existing `organ.*` no-op envelope rather than growing the stand-in substrate's vocabulary. `witness` keeps the observed value inline (audits of unpaired reads and throttled tides stay honest). |
| `write`, cell unborn | `{type: "init", cellId, kind: "value", value, by, cause, chrono}` | **R2.** Chrono cells are BORN on first write (engine init-writes; push sinks born by first delivery). Organ `set` refuses a nonexistent cell; `init` WITH the value is the exact single-receipt birth. `kind` is `"value"` because a bare chrono ledger proves only values (the seal manifest refuses any other kind). |
| `write`, cell born | `{type: "set", cellId, value, by, cause, chrono}` | **R3.** Direct correspondence; nothing invented. |
| push | the **pair**: witness receipt + init/set receipt | **R4.** A push is not an entry type: chrono's `recordFlow()` appends a (read, write) pair sharing a `flow_id` (source read, sink write, `pushed=true`). 1:1 mapping carries the pair over as (witness, transition) — and the pairing law is ENFORCED in translation (see §9.3), so a write claiming a flow with no read refuses, exactly as chrono's ledger law refuses. |

Cross-cutting decisions:

- **R5 — self-describing receipts.** Every mapped op embeds
  `chrono: {seq, hash}` (its source link's seq + receipt hash). The organ
  ledger names the exact sealed chrono bytes behind every entry, and the
  mapped receipt hash covers the binding.
- **R6 — wall-clock does not cross.** `ts_utc` stays in the sidecar,
  reachable through the chrono pointer: organ law "receipts carry no
  wall-clock time; seq is time" (§2 I3). `by`/`cause`/`pushed` are causal,
  not clock, and ride along.
- **R7 — fail-closed on the rest.** An op that is not `read`/`write`, a
  missing/empty cell, or a value with no canonical JSON form refuses with
  `CHRONO_OP_UNMAPPABLE`. Never coerced, never skipped.

### 9.2 Custody shape (R8–R10)

The mapped receipts form a NEW organ receipt chain anchored at GENESIS whose
replay reproduces the sealed manifest's state — proven, not assumed (§9.3
step 7). Then:

- **R8 — manifest inheritance.** With the seal at the chain tip, the SIGNED
  seal manifest is reused verbatim as the organ bundle manifest: the bytes
  the HMAC anchors are the bytes the organ boots. (Chrono's manifest already
  satisfies `validateManifest` — proven by 67-a's interop tests — and its
  per-cell hashes are `sha256({kind:"value", value})`, exactly the organ
  formula.)
- **R10 — post-seal appends.** Links past the seal are carried (they are
  chain-linked to the boundary; any tamper breaks the chain at a named seq).
  The tip bundle is re-snapshotted with the SAME organId and
  `supersedes = <sealed manifestHash>` (identity carried, honest lineage).
  The tail is hash-chain custody, not signature custody — the §8.3 honest
  scope inherited.
- **R9 — provenance kind.** The booted organ carries
  `organ.custody = {kind: "chrono-seal", alg, signedAt: {seq, hash,
  manifestHash}, sealedRange, verifiedRange, chainTip}`. Honestly kinded
  `chrono-seal`, NOT `signed-checkpoint`: the mapped bundle is FULL custody
  from GENESIS (the adapter carried every receipt), so there is no custody
  gap for a checkpoint to anchor — the seal vouches for the chrono SOURCE
  chain. A re-snapshot therefore drops the chrono provenance but stays
  bootable (parked: provenance-carrying re-snapshots).

### 9.3 The courtroom (bootChrono, in order, all fail-closed)

1. shape — `{links, checkpoint}` objects, non-empty links → `CHAIN_GAP` /
   `CHECKPOINT_MALFORMED`
2. `verifySignedCheckpoint` (§8 law, unmodified) →
   `CHECKPOINT_SIGNATURE_REQUIRED` / `CHECKPOINT_MALFORMED` /
   `CHECKPOINT_SIGNATURE_INVALID`
3. the seal's manifest re-hashes to the SIGNED manifestHash and is a
   full-prefix manifest `[0..seq]` → `CHECKPOINT_ANCHOR_MISMATCH`
4. the links re-verify as an organ receipt chain (the §67-a byte-formula
   identity, now verified per boot) → `CHAIN_GAP` / `RECEIPT_HASH_MISMATCH`
5. the seal pins THIS chain: `checkpoint.seq ≤ tip` and
   `checkpoint.hash === links[checkpoint.seq].hash` →
   `CHECKPOINT_SEQ_BEYOND_RECEIPTS` (truncation) /
   `CUSTODY_CHECKPOINT_MISMATCH` (wrong chain/boundary)
6. the mapping (§9.1) → `CHRONO_OP_UNMAPPABLE` / `CHRONO_FLOW_UNPAIRED`
7. mapped replay at the boundary == the SIGNED manifest's state hash →
   `REPLAY_DIVERGENCE`
8. the REAL `boot()` runs the whole §2–§8 courtroom on the mapped bundle
   (manifest, state hashes, chain, replay == carried state) — nothing from
   steps 1–7 is trusted except the right to construct the bundle.

New fail-closed codes (everything else reuses §4/§7/§8 codes verbatim):

| Code | Failure mode | Fail-closed rule |
|------|--------------|------------------|
| `CHRONO_OP_UNMAPPABLE` | an entry the §9.1 mapping refuses: verb outside `read`/`write`, no cell, entry/link seq disagreement, non-canonical value | refuse the boot — never coerce, never skip |
| `CHRONO_FLOW_UNPAIRED` | a flow-tagged write with no read of the same `flow_id` anywhere in the chain | refuse — chrono's causal-fabric law ("a write without a cause-read is a hole in the causal fabric") crosses the boundary with the write |

### 9.4 v9 (§9) acceptance — proven by `node --test tests/chrono-interop.test.mjs` (16 tests; 60/60 with the v0–v2 suite)

1. The committed fixture IS a real chrono seal: organ `verifySignedCheckpoint`
   accepts it; the sidecar verifies under organ `verifyChain`; tip == sealed
   hash.
2. Round-trip: sealed sheet → booted organ; `organ.cells` deep-equal the
   independent write-fold oracle; organId/manifestHash CARRIED from the seal;
   with the seal at the tip, `organ.manifest` is the signed manifest
   byte-for-byte.
3. Mapping decisions land exactly as §9.1's table (R1–R4), including the
   no-op proof (`applyOp` on a witness receipt leaves cells untouched) and
   the push pair birthing its sink (R2 inside R4).
4. The mapped ledger is self-describing (every receipt carries its
   `chrono: {seq, hash}` binding) and wall-clock-free.
5. Tamper at every offset (all 7 links, one at a time) →
   `RECEIPT_HASH_MISMATCH` naming the seq; forged sig / tampered signed
   field / wrong key / missing key → the §8 codes; truncation below the
   boundary → `CHECKPOINT_SEQ_BEYOND_RECEIPTS`; a genuine-anchor/wrong-chain
   swap → `CUSTODY_CHECKPOINT_MISMATCH`; a re-signed bogus anchor →
   `CHECKPOINT_ANCHOR_MISMATCH`; an internally-consistent re-hashed chain
   anchored to a STALE signed manifest → `REPLAY_DIVERGENCE`.
6. Semantic refusals: a non-chrono verb → `CHRONO_OP_UNMAPPABLE`; an
   unpaired flow write → `CHRONO_FLOW_UNPAIRED` (and pairing it repairs the
   chain).
7. The organ is ALIVE: post-seal appends boot honestly (custody records
   signed ⊂ verified; lineage pins the sealed manifest; tail tamper still
   refused); `stateAt`/`rewind` equal the independent fold at every seq; the
   organ continues appending from the rewound tip on the SAME hash chain;
   full custody means rewind to seq 0 is legal; the organ re-snapshots
   (standalone, no key), nests into a toy quilt, and double-entry verifies.
8. LIVE interop (skip-if-absent): a sheet built with chrono's `Ledger`,
   sealed with chrono's `seal()`, boots through `bootChrono` to the same
   cells chrono's own `verifyCustody` returns; a tampered live sidecar
   refuses by name.

### 9.5 Honest scope, inherited and new

- **HMAC symmetric (§8.5, unchanged):** the keyholder is the minter. A
  verifier with the key can re-mint anything; the tests exercise exactly
  this when they craft valid seals over crafted chains. Asymmetric Ed25519
  (v3) upgrades the chrono seal with zero format drift (the checkpoint doc
  is already organ-exact).
- **The seal vouches for the SOURCE chain; the mapped bundle self-proves.**
  A translated bundle floating without its seal is a plain full-custody
  organ bundle (its integrity is self-evident by hashes) — keep the seal
  with the bundle when source custody matters.
- **Bridge asymmetry (new, receipted):** the chrono sidecar VERIFIES under
  organ `verifyChain` (the hash formula is shared) but cannot be MINTED by
  organ `makeReceipt`, which demands `op.type` — chrono entries name their
  verb in `op.op`. The bridge's mapped receipts DO satisfy `makeReceipt`
  (their ops carry `type`). Verified-vs-mintable is exactly the boundary
  between the two substrates, and it is tested on both sides.
- **Parked (in demand order):** chrono-verb appends after boot (a booted
  chrono organ appends ORGAN ops; feeding new chrono entries through the
  organ ledger is a one-way custody transfer today — continue the chrono
  ledger and re-seal instead); seal-lineage propagation through
  `snapshotOrgan` (provenance-carrying re-snapshots); `render`-shaped chrono
  cells (chrono formula cells would map to derived-value writes; the bare
  ledger proves values only — same law as the seal); O(tail) booting of a
  chrono sheet from the sealed seed (the mapped bundle replays from GENESIS;
  partial-custody carving needs a mapped-chain boundary pin, which the
  mapped ops make possible in a future lane); ~~Ed25519 (v3)~~ **DELIVERED in
  §10** — a chrono seal is an organ-exact checkpoint doc, so it upgrades to an
  Ed25519 signer with zero format drift (mint the seal checkpoint with
  `signCheckpointEd25519` instead of HMAC; `bootChrono`'s verification doorway
  is the same `verifySignedCheckpoint` dispatch).


---

## 10. v3 — Ed25519 attribution: the checkpoint signer has a name (wave-68, lane 68-b)

§8.5's top parked item, landed as the quest-log's move #5 ("Ed25519 attribution
so scars carry names"). HMAC's honest residual, receipted in §8: the keyholder
is the minter and vice versa — every writer holds FULL signing power, so
"who vouches" was fleet-trust, not identity. v3 splits the power with Ed25519
(`node:crypto`, stdlib, zero deps): the private key mints, the public key
verifies, and the public key HAS A NAME.

### 10.1 The v3 checkpoint (`src/organ/ed25519.mjs` + `checkpoint.mjs`)

`signCheckpointEd25519(bundle, seq, privateKeyPem)` runs the SAME discipline as
v2's `signCheckpoint` — the FULL boot courtroom first (`verifyBundle`), then
the prefix replay, then the same canonical triple — and signs it with Ed25519:

```
{ schema: "quilt.organ.checkpoint", schemaVersion: 1, alg: "Ed25519",
  seq, hash, manifestHash,                      // the v2 triple, unchanged
  publicKeyFingerprint: <sha256 of the signer's SPKI PEM, 64-hex>,
  sig: <128-hex Ed25519 over canonical({hash, manifestHash, seq})>,
  manifest: <the prefix snapshot's manifest, hash-addressed to manifestHash> }
```

**The fingerprint law** (shared byte-for-byte with quilt-mcp-receipts' qmr3
attribution layer — the cross-repo proof leans on it): an identity's name is
`sha256(SPKI-PEM(public key))`, where the PEM is the normalized
`createPublicKey(...).export({type:"spki",format:"pem"})` output. The name is
derivable from the private PEM too (the public half is derived first), stable
across runs, and identical in both repos.

### 10.2 Verification — the key HOLDS the trust

`verifySignedCheckpoint(cp, key)` is the one doorway and now dispatches on
`alg`: `HMAC-SHA256` → the v2 path (byte-identical); `Ed25519` → the key
argument is the verifier's PUBLIC key PEM, and the law is three named
refusals: unusable key material → `CHECKPOINT_SIGNATURE_INVALID` (the trust
root itself is malformed); key fingerprint ≠ `cp.publicKeyFingerprint` →
`CHECKPOINT_SIGNATURE_INVALID` ("wrong key" — the checkpoint names its signer,
and a verifier holding a different key refuses BEFORE any crypto); signature
fails → `CHECKPOINT_SIGNATURE_INVALID`. `verifyCheckpointEd25519(cp,
publicKeyPem)` is the explicit v3 spelling of the same law. Unknown
algorithms still refuse `CHECKPOINT_MALFORMED` — the v2-predicted growth slot,
grown into without drift.

### 10.3 Custody provenance gains a name

Booted organs carry `custody.signer` — `{kind: "ed25519", anchoredAt,
publicKeyFingerprint}` for v3, and `{kind: "hmac-sha256", anchoredAt}` for v2
(no fingerprint: a shared secret has no name — the honest residual, now
receipted IN the provenance). All other custody fields (`signedAt`,
`verifiedRange`, `seed`, `checkpoint`) are unchanged.

### 10.4 Key rotation — the era walk

A bundle may carry a CHAIN of checkpoints (`bundle.checkpoints`, strictly
ascending seq; minted under different keys, possibly different algorithms) via
`carveRotatedCustody(full, checkpoints)` — keyless-mechanical like
`carvePartialCustody`, refusing any checkpoint that does not describe the
bundle's prefix at its own seq. The carried shape: receipts
`[firstSeq+1..tip]`, ONE seed at `firstSeq`, all the checkpoints.

Boot (`{ checkpointKeys: [k0, k1, ...] }`, one keying material per era)
verifies each era with ITS key only:

- **era 0** anchors the carried seed — the exact v2 law (sig → boundary pin →
  anchor manifest → seed state);
- **era i > 0** is proven by REPLAY from era i−1's anchor: replay
  `(seqᵢ₋₁, seqᵢ]` from the previous era's anchored state, then the era-i
  checkpoint must pin the carried receipt at `seqᵢ` and its signed anchor
  manifest must claim EXACTLY the replayed state. A genuine key signing a
  state the previous era cannot reach is `CUSTODY_CHECKPOINT_MISMATCH` — the
  custody chain does not cross that key boundary.

So custody crosses key rotations without any shared secret: era 1's trust is
transitive through replay, and each key is checked against its own era. The
provenance carries the full name chain: `custody.signers = [signer₀, signer₁,
…]` (and `custody.signer = signer₀`, the seed's anchor). The HMAC→Ed25519
rotation is the tested v2→v3 migration story.

### 10.5 Fail-closed surface (v3 additions)

| Code | Failure mode | Fail-closed rule |
|------|--------------|------------------|
| `CHECKPOINT_SIGNATURE_INVALID` | Ed25519 sig fails, wrong public key (fingerprint mismatch), unusable key material; rotation: any era's key/sig failing | refuse boot |
| `CHECKPOINT_MALFORMED` | ed25519 doc missing/invalid `publicKeyFingerprint`, sig not 128-hex, unknown alg, `checkpoint` AND `checkpoints` both present, non-ascending rotation seqs, malformed `checkpoints` array | refuse boot / the operation |
| `CHECKPOINT_SIGNATURE_REQUIRED` | no key for a singular checkpoint; era/key count mismatch on a rotation chain | refuse boot |
| `CUSTODY_CHECKPOINT_MISMATCH` | (existing) rotation: era-i anchor pins a receipt hash the carried chain does not have, or claims a state era i−1's custody cannot reach — the era bridge is broken | refuse boot |
| `CHECKPOINT_ANCHOR_MISMATCH` / `CHECKPOINT_SEQ_OUT_OF_RANGE` / `CHECKPOINT_MINT_INVALID` | carve-side rotation refusals (swapped prefix manifests, tip-anchored eras, unproven sources) | refuse the operation |

### 10.6 v3 acceptance (proven by `node --test test/organ.test.mjs`; 54/54 with the v0–v2 sections, 70/70 with §9's chrono suite)

1. Round-trip: sign → verify (both doorways) → carve → partial boot ==
   full boot byte-for-byte; `custody.signer` names the fingerprint; v2 boots
   gain `{kind:"hmac-sha256"}` signer provenance.
2. Fingerprint law: identical from public or private PEM; 64-hex; different
   identity → different name.
3. Forgery: flipped sig / tampered `seq` (inside the triple) / tampered
   `manifestHash` → `CHECKPOINT_SIGNATURE_INVALID`; stripped
   `publicKeyFingerprint` → `CHECKPOINT_MALFORMED`.
4. Wrong key: another identity refuses by name (naming "wrong key"); a
   different-identity boot refuses; unusable PEM refuses.
5. Courtroom invariants: unsigned gap still `CUSTODY_GAP`; no key still
   `CHECKPOINT_SIGNATURE_REQUIRED`; unknown alg still `CHECKPOINT_MALFORMED`.
6. Rotation (2 keys, 2 eras, HMAC→Ed25519) boots byte-identical to the full
   bundle; `custody.signers` carries both names across the key boundary;
   same-alg (Ed25519→Ed25519) rotation also boots.
7. Rotation key discipline: swapped keys, wrong-era Ed25519 key, and missing
   era keys all refuse by name.
8. Rotation tamper: naive tail tamper → `RECEIPT_HASH_MISMATCH`; a
   SELF-CONSISTENT re-hash inside era 1 → `CUSTODY_CHECKPOINT_MISMATCH` (the
   era bridge catches what the chain law cannot).
9. Re-snapshot: an Ed25519 partial-custody organ re-snapshots and boots under
   the same public key, signer provenance intact.
10. Mint discipline: unproven snapshots, partial-custody sources, out-of-range
    boundaries, and unusable keys all refuse before any signature exists.

### 10.7 Honest scope, inherited and new

- **The v3 anchor vouches for the PREFIX exactly as v2's does** (§8.3's scope
  paragraph unchanged): post-checkpoint custody is the v0 law; a fully
  re-hashed post-checkpoint history is a different fork, not a detectable
  forgery. What v3 adds is WHO vouched, not WHAT is vouched for.
- **Key distribution is trust-on-first-use, receipted:** the protocol verifies
  signatures under keys the verifier CHOOSES to hold; issuance, revocation,
  and web-of-trust are PKI infrastructure, parked (§8.5's residual). A
  rotation chain is only as trustworthy as the out-of-band knowledge that
  era i's key legitimately succeeded era i−1's.
- **The private PEM verifies** (`createPublicKey` derives the public half) —
  convenient for tests; a verifier that holds a private key holds the
  minter's power too, which is a trust-root choice, not a protocol break.
  The cross-repo demo keeps the private key runtime-only and shares only the
  public key + fingerprint.
- **Re-snapshots carry the era-0 anchor only** (`snapshotOrgan` re-carries
  `custody.checkpoint` = the seed's anchor + the seed): the re-snapshot boots
  under era 0's key alone (weaker custody, still valid — era 0 legalizes the
  whole carried gap). Propagating deeper rotation anchors through
  re-snapshots is parked.
- **Parked (in demand order):** organ-side keyrings (boot takes explicit
  keys; the keyring {fingerprint → key} law lives on the qmr2 attribution
  side and can port back in a later lane), revocation lists, checkpoint
  expiry/validity windows, multi-signer (k-of-n) checkpoints.
