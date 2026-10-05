# quilt-jev-toolkit — Agent Onboarding
> Zero-shot entry point. Clone → competent in ~10 minutes.

## Identity (2 sentences)

quilt-jev-toolkit is two tools in one small repo: the fleet's reference client
for the JEV judge API (`jev_client.py` — the noul/choice/score wire protocol
other lanes copied verbatim, with a canon-gate CLI on top), and, since wave 63,
the home of the **Cell-Organ Snapshot & Boot protocol** — a receipt-chain
ledger format that lets you snapshot, rewind, transact, and boot saved cell
states ("organs") with fail-closed custody, checkpoint signatures (v2 HMAC,
v3 Ed25519), key rotation, revocation enforcement, and even booting a sealed
quilt-chrono sheet (§9).

## Why it exists (the fleet problem it solves)

The fleet needed two hard problems solved cheaply. First, doctrine claims
needed a judge: this repo's discovery rounds (Sept 24, 2026) measured JEV's
behavior (95% factual accuracy, 7/7 adversarial resistance, 66 ms/call at 50
parallel calls, determinism p 0.980–0.990) and gated 50 fleet repos for
canon-worthiness (FLEET_GATE_RESULTS.md). Second, agents die mid-task and
sandboxes wipe: the organ protocol makes a cell group's entire history a
content-addressed, replay-verifiable bundle that a fresh process can boot and
continue — nothing trusted, everything re-proven (boot is the courtroom).
Built across waves: 63-c (v0 custody), 64-a (v1 rewind family), 65-b (v2
checkpoint signatures), 68-a (§9 chrono adapter), 68-b + 68-b-r2 (v3 Ed25519 +
the death audit), 69-b (§11 revocation enforcement). The wave-66 decomposition
(Task 66-d) counted 26 distinct fail-closed rules across §4/§7.3/§8.3; wave-67
(Task 67-j) reused this repo's protocol verbatim when the native JEV transport
died.

## Verify it works (exact commands)

```bash
# 0. Requirements: Node >= 18. Zero external npm dependencies.

# 1. The proof suite — measured 2026-10-04 on this tree:
#    74 tests: 73 pass, 0 fail, 1 skip (the LIVE chrono-interop test skips
#    when the ../quilt-chrono sibling is absent; the committed fixture
#    tests/fixtures/chrono-fixture.json carries that proof).
npm test

# 2. The end-to-end demos (offline, no keys, ~seconds each). Both PASS:
npm run demo           # snapshot → corrupt → fail-closed → boot → nest → re-snapshot
npm run demo:rewind    # transact → atomicity → stateAt → rewind → compensating credit

# 3. Organ one-liners (runnable exactly as the README shows):
node -e 'import("./src/organ/boot.mjs").then(async ({ boot }) => {
  const { buildGreeterQuilt } = await import("./examples/greeter-organ.mjs");
  const { snapshot } = await import("./src/organ/snapshot.mjs");
  const q = buildGreeterQuilt();
  const organ = boot(snapshot(q.cells, q.ledger, { name: "greeter-organ" }));
  console.log(organ.cells.out.value);   // "Ahoy, SuperInstance!"
});'

# 4. The JEV oracle side REQUIRES a TypeSafe API key — it cannot run without
#    one. Keys are env-read only (never committed):
#    export TYPESAFE_API_KEY=...    # legacy TYPESAFEAI_KEY also accepted
#    python3 jev_client.py "the earth is round" \
#      '{"x": {"type": "noul", "instructions": "Is this true?"}}'
#    Proof the live path worked when a key existed: the discovery round table
#    in README.md and FLEET_GATE_RESULTS.md (50-repo canon gate, Sept 24 2026).

# 5. The credential ritual (fleet law since the wave-67/68 scrub):
node scripts/keyscan.mjs   # must print CLEAN; exit 1 on any un-receipted hit
```

Note: running the demos regenerates `examples/receipts/boot-demo-receipt.json`
and `rewind-v1-demo-receipt.json` with a fresh `writtenAt` (the organ and
state hashes are deterministic — `greeter-organ@37b387834d456c92`).

## Reading order (paths, not vibes)

1. `README.md` — the whole protocol story by version (v0→v3, §9, §11) with
   runnable commands per layer; read top to bottom once.
2. `docs/REVERSE-ACTUALIZED-SPEC.md` — the doctrine: §2 invariants, §3
   manifest format (`quilt.organ.manifest/v1`), §4 fail-closed rules, §5
   nesting envelope, §7 v1, §8 v2, §9 chrono, §10 v3, §11 revocation.
3. `DESIGN.md` — design passes with the REJECTED alternatives (a rejected
   alternative is a lesson someone else doesn't re-pay).
4. `src/organ/snapshot.mjs` then `src/organ/boot.mjs` — custody claim and the
   courtroom (597 lines; every fail-closed code is named here).
5. `test/organ.test.mjs` — the proofs, including the self-consistent forged
   chain that only replay catches.
6. `examples/boot-demo.mjs` / `examples/rewind-demo.mjs` — the end-to-end
   choreography with stage assertions.
7. `jev_client.py` + `canon_gate.py` — the JEV side; then
   `FLEET_GATE_RESULTS.md` for the measured gate.
8. `receipts/68-b-death-audit.md` — what a dead lane leaves, and how a
   finisher audits it; a masterclass in fleet honesty.

## The things that will bite you (gotchas)

- **Nothing is trusted, everything is re-proven**: boot re-verifies every
  receipt hash and replays to assert hash-equality with the carried state
  before ANY query or write. Do not add fast paths that skip the courtroom —
  that is what the fail-closed codes protect.
- **A range starting at seq > 0 with no checkpoint is unowned history** →
  `CUSTODY_GAP`, refuse. Partial custody is legal ONLY under a verified
  signature (v2/v3); unsigned gaps stay illegal (v2 changed this on purpose).
- **HMAC has no name**: v2 custody provenance honestly records
  `{kind: "hmac-sha256"}` — a shared secret has no identity. Attribution
  (named signers, fingerprints) is v3 Ed25519 only.
- **Runtime keys, never committed**: `generateEd25519Keypair()` mints at run
  time; the fleet key-scan law (`scripts/keyscan.mjs`) exists because a
  credential once leaked into a committed receipt elsewhere (cot-quilt
  incident, 2026-10-01). Fingerprints and hashes may be committed; key
  material never.
- **The toy substrate is a stand-in by design**: `src/organ/toyQuilt.mjs`
  (init/set/render, 4 op types, clock-free) exists to disappear when a real
  cells/ledger layer lands. Do not grow it for foreign substrates — that was
  Alternative A in DESIGN.md §4 and it was REJECTED; write an adapter like
  `chronoOps.js` instead.
- **Wall-clock is banned from receipts**: `seq` is time. Anything that embeds
  a timestamp breaks replay determinism and the byte-addressing invariant I1.
- **Dialect drift is real**: the toolkit's dialect is
  `quilt.organ.manifest/v1`; the fleet organ store (Cloudflare Worker) speaks
  `quilt.organ.v1` — uploads go through a receipted adapter
  (`examples/upload-v1-states.mjs`); native-dialect refusal is receipted as
  the DIALECT_DRIFT finding; unification was parked to lane 64-c.
- **Stale references in README "Files"**: `discovery_log.md`, and (per older
  fleet hints) `tools/jev_gate.py` / `jev_batch.py`, are NOT in the tree —
  the discovery findings survive in README + FLEET_GATE_RESULTS.md. Trust the
  tree over the file list.
- **`criteria` is required** for `score` and `choice` questions on the JEV
  wire; noul's criteria is optional. The response model name is the concrete
  version (`jev-1.13.0`), not the `jev-latest` alias you sent.
- **The LIVE chrono-interop test skips without the sibling**: checkout
  `../quilt-chrono` and re-run if you need that test live; the committed
  fixture covers the same path deterministically.

## Where deeper knowledge lives

- Knowledge map: [docs/KNOWLEDGE-MAP.md](./KNOWLEDGE-MAP.md)
- Fleet journal: SuperInstance/superinstance-lab → worklog.md (grep
  'quilt-jev-toolkit'; Task IDs 63-c, 64-a-r, 64-c-r, 65-b, 66-d, 67-j, 67-p,
  68-a, 68-b are the lineage)
- `examples/receipts/` — the four evidence receipts (boot v0, rewind v1 demo
  + upload, v3 attribution): hashes and fingerprints only, never key material.
- `receipts/` — `68-b-death-audit.md` (dead-lane audit) and
  `v3-cross-repo-proof.md` (one Ed25519 identity verified by two repos'
  independent verifiers).
- `DESIGN.md` + `docs/REVERSE-ACTUALIZED-SPEC.md` — the design law.
- `scripts/keyscan.mjs` — the pre-push credential ritual and its output
  discipline (matched values are NEVER printed).
- Sibling repos: jev-quilt (the doctrine + oracle measurements this toolkit's
  client serves), jeviter (the ledger law sibling), quilt-mcp-receipts (the
  qmr2 attribution layer proven cross-repo in v3), quilt-chrono (the sealed
  sheet substrate booted by §9), quilt-organ-workers (the store the upload
  receipt points at).

## Current frontier (what is open right now)

- **§11's signed-statement layer is parked by design**: the enforcement half
  of key revocation is live (`revokedKeys` → `E_KEY_REVOKED`), but signed
  revocation statements remain a parked spec item (spec §11 parking receipt).
- **Dialect unification** (`quilt.organ.manifest/v1` vs the worker's
  `quilt.organ.v1`) is parked from lane 64-c; the adapter + receipted refusal
  is the current state.
- **The toy substrate is still the substrate**: adapting the organ code onto a
  real cells/ledger layer (quilt-upstream or here) is the named next move
  (README v0 substrate note; DESIGN.md §4's deeper intent).
- Key distribution remains trust-on-first-use (spec §10.7) — the anchor
  vouches for the prefix; how a verifier learns a public key honestly is
  unsolved fleet-wide.
- The JEV discovery rounds (1–9) have not been re-run since 2026-09-24 and
  the native TYPESAFEAI_KEY transport was lost (worklog Task 67-j); the JEV
  side is receipted history until a key returns.

---

## Fleet seed (2026-10-06 handoff) — momentum, vision, roadmaps, mesh

> Additive section for follow-up agents; the sections above are the
> zero-shot mechanics. Mesh context: `SuperInstance/fleet-seeds` →
> `docs/handoff-2026-10-06/ORG-MESH.md`.

### Momentum since the doc above froze

- **Organ custody v0→v3 shipped**: snapshot/boot/nest (v0), the rewind
  family + write-side transactions (v1), checkpoint signatures + partial-
  custody replay seeds (v2), **Ed25519 attribution — the checkpoint signer
  has a name** (v3: `signCheckpointEd25519`, key rotation, the death audit
  counting 26 fail-closed rules), §9 chrono adapter (a sealed quilt-chrono
  sheet boots as an organ), §11 key revocation (enforcement half live,
  statement half designed + parked). Wave-69 docs package refreshed all
  guides; wave-68 dog-food re-ran demos against live receipts.
- **FB6 (PR #1 open):** the zeroclaw journal boots as an organ — custody
  courtroom + byte-exact replay, re-deriving every fnv1a64 row hash from
  GENESIS, normalizing both historical genesis representations, refusing
  tamper/swap with named rows. The lesson pinned inside: hand-transcribed
  fixtures recompute wrong — always lift fixtures verbatim from the shipped
  journal.
- **The JEV reference client side** is env-key-gated and currently dark
  (Typesafe key revoked 2026-10-06). The offline organ protocol is fully
  live and needs no key.

### Vision

Two hard problems solved cheaply, forever: (1) doctrine claims need a judge —
this repo measured JEV's behavior (95% factual accuracy, 7/7 adversarial
resistance, 66 ms/call, determinism p 0.980–0.990) and gated 50 fleet repos
for canon-worthiness; (2) agents die mid-task and sandboxes wipe — the organ
protocol makes a cell group's entire history a content-addressed,
replay-verifiable bundle a fresh process can boot and continue. **Boot is the
courtroom**: nothing trusted, everything re-proven. That phrase is the repo
in six words.

### Roadmaps (several directions)

1. **Merge FB6 (#1)** — zeroclaw journal custody; then the journal becomes a
   reference fixture for every future custody consumer.
2. **§11 statement half** — the designed-not-built revocation statement
   machinery; small, well-specified, parked by choice.
3. **Organ networking** — organs compose (nesting exists); a *registry* of
   organ bundles with custody proofs across repos is the natural v4, and
   would slot under fleet-witness checkpoints as the serving layer.
4. **Live-JEV revival** — with a fresh key: re-run the fleet gate on repos
   minted since wave-69, and adopt jev-quilt's R6 measurement discipline
   (same-window voting) before trusting any single verdict.
5. **quilt-chrono deepening** — §9 proved a sealed sheet boots; sheet-*state*
   rewind (not just boot) is the adjacent build.

### How it meshes

- **Wire-protocol donor:** `jev_client.py`'s noul/choice/score protocol was
  copied verbatim by jev-quilt and other lanes; keep it the reference.
- **Identity sharing:** organ v3 Ed25519 semantics are byte-identical with
  quilt-mcp-receipts qmr2 §8 attribution (sigKeyFp = sha256 of SPKI PEM) —
  cross-repo identity is a feature, not drift.
- **Consumers:** doubt-ledger discharge rows, zero-msg-test decision chains
  (if that lane opens), any lane needing custody of cell state.
- Org state: `fleet-seeds` → `docs/handoff-2026-10-06/HANDOFF.md`.
