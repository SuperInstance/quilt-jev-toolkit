# quilt-jev-toolkit — User Guide

## What you get

Two capabilities, no dependencies (Node >= 18 for the organ side; Python 3 for
the JEV side):

1. **The JEV canon oracle client** (`jev_client.py`, `canon_gate.py`): a
   minimal client for the TypeSafe JEV API with `noul` / `choice` / `score`
   question builders, plus a CLI that scores documents for canon promotion
   (canon-p, depth, domain). Requires `TYPESAFE_API_KEY` (legacy
   `TYPESAFEAI_KEY` accepted) — env-read, never committed.
2. **The Cell-Organ Snapshot & Boot protocol** (`src/organ/`): treat a group
   of cells plus its receipt-chain history as a portable **organ** — snapshot
   it to a content-addressed bundle, boot it into a fresh process or host
   quilt (fail-closed), query it in time travel (`stateAt`), rewind it with
   compensating double-entry, write with all-or-nothing transactions, mint
   signed checkpoints (v2 HMAC-SHA256, v3 Ed25519 with named signers, key
   rotation, wave-69 revocation enforcement), and even boot a sealed
   quilt-chrono sheet as an organ (§9).

## Install

```bash
git clone https://github.com/SuperInstance/quilt-jev-toolkit.git
cd quilt-jev-toolkit
npm test            # 74 tests (73 pass, 1 skip) — offline, no keys, <1s
# JEV side (optional): python3 with stdlib only; needs TYPESAFE_API_KEY in env
```

## First success in 5 minutes

Boot an organ and ask it what it knows:

```bash
node -e 'import("./src/organ/boot.mjs").then(async ({ boot }) => {
  const { buildGreeterQuilt } = await import("./examples/greeter-organ.mjs");
  const { snapshot } = await import("./src/organ/snapshot.mjs");
  const q = buildGreeterQuilt();   // 4 cells, 12 receipts
  const organ = boot(snapshot(q.cells, q.ledger, { name: "greeter-organ" }));
  console.log(organ.cells.out.value);
});'
```

Expected output (from an actual run 2026-10-04):

```
Ahoy, SuperInstance!
```

That value was not asserted — it was *proven*: every receipt hash re-verified,
and replaying the receipt range on empty cells produced a state hash-equal to
the carried state. Then run the full choreography:

```bash
npm run demo          # ends: organ says: "Ahoy, SuperInstance!" (organId greeter-organ@…)
npm run demo:rewind   # ends: subject="after-rewind" — rewind, continue, custody unbroken
```

## Everyday usage

### 1. Snapshot / boot / nest an organ

```js
import { snapshot } from './src/organ/snapshot.mjs';
import { boot } from './src/organ/boot.mjs';

const bundle = snapshot(quilt.cells, quilt.ledger, { name: 'my-organ' });
const organ = boot(bundle);                    // standalone: fail-closed courtroom
const nested = boot(bundle, { host: hostQuilt });  // nesting envelope: organ keeps
                                                // ITS OWN ledger; host gets pointer
                                                // receipts (organ.nest / organ.credit)
```

The five invariants (README): content addressing, chain of custody,
deterministic replay, manifest-as-claim, nesting without host breakage.

### 2. Time travel and transactions (v1)

```js
import { stateAt, rewind, transact } from './src/organ/rewind.mjs';

const view = stateAt(bundle, 5);          // pure; hash-asserted against an
                                          // independent prefix replay
const r = transact(bundle, ops);          // all ops or nothing; input bundle
                                          // byte-untouched on any failure
const rewound = rewind(organ, 0);         // organ form truncates + rebuilds by
                                          // pure replay; nested organs emit ONE
                                          // compensating host receipt
```

Atomicity is proven, not promised: fail op 2 of 3 → `OP_APPLY_FAILED` at
`failedOp: 1`, staged effects never leak (test + demo stage).

### 3. Signed checkpoints and partial custody (v2)

```js
import { signCheckpoint, carvePartialCustody } from './src/organ/checkpoint.mjs';

const cp = signCheckpoint(fullBundle, 7, 'fleet-key');       // HMAC-SHA256
const partial = carvePartialCustody(fullBundle, cp);          // receipts [8..tip] + seed
const organ = boot(partial, { checkpointKey: 'fleet-key' });  // boot pays O(tail), not O(history)
```

Boot of a 10-million-receipt organ costs O(tail) — genesis is replayed once at
checkpoint time, never at boot. Unsigned custody gaps still fail closed
(`CUSTODY_GAP`).

### 4. Attribution and rotation (v3)

```js
import { generateEd25519Keypair } from './src/organ/ed25519.mjs';
import { signCheckpointEd25519 } from './src/organ/checkpoint.mjs';

const id = generateEd25519Keypair();          // RUNTIME keys — never committed
const cp = signCheckpointEd25519(bundle, 7, id.privateKeyPem);
// cp.publicKeyFingerprint = sha256 of the signer's SPKI PEM — the signer has a name
// verifyCheckpointEd25519(cp, publicKeyPem) → { ok } or fail-closed code
// carveRotatedCustody(full, [cpHmac, cpEd25519]) — multiple eras, each key
//   checks ITS era; later eras proven by replay from the previous anchor
```

Mint a ready-made keyring (identity + fingerprint + verifier map):

```bash
node examples/keyring-mint.mjs
```

### 5. Revoke a key (wave-69, §11 enforcement)

```js
const organ = boot(bundle, { checkpointKey: publicKeyPem,
  revokedKeys: { [fingerprint]: revocationSeq } });
// eras anchored after revocationSeq refuse with E_KEY_REVOKED
```

HMAC eras are immune by shape (no fingerprint to revoke); malformed
revocation maps are refused, never partially trusted; the non-throwing
`verifyBundle` carries the same verdict in `errors[0]`.

### 6. Boot a sealed quilt-chrono sheet (§9)

```bash
node -e 'import("./src/organ/chronoOps.js").then(async ({ bootChrono }) => {
  const f = JSON.parse((await import("node:fs")).readFileSync("./tests/fixtures/chrono-fixture.json", "utf8"));
  const organ = bootChrono({ links: f.links, checkpoint: f.checkpoint }, { key: f.key });
  console.log(organ.manifest.organId, JSON.stringify(organ.cells));
});'
# → chrono-demo@ef28377edd1b07fc {"sensor.temp":{...22.1},"sink.display":{...22.4}}
```

Reads map to no-op witness receipts, writes to cell sets, pushes to the
(witness, set) pair — every decision named and tested (`CHRONO_OP_UNMAPPABLE`,
`CHRONO_FLOW_UNPAIRED` are the semantic refusals).

### 7. Canon-gate a document with JEV (needs key)

```bash
export TYPESAFE_API_KEY=...            # env only — never put it in a file
python3 canon_gate.py path/to/file.md  # → canon-p, depth, domain, CANON/draft
python3 canon_gate.py --batch docs/    # walk a directory
```

Measured context (Sept 24, 2026 discovery rounds): 95% accuracy on factual
sweep, 12/12 on myth-busting, 7/7 on prompt-injection resistance, 50 parallel
calls in 3.3 s (66 ms/call), p-range 0.980–0.990 across 10 runs. The 50-repo
fleet gate results are in FLEET_GATE_RESULTS.md (top: quilt-canary 0.70,
jev-quilt 0.60).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `OrganBootError: CUSTODY_GAP` | Receipt range starts at seq > 0 with no checkpoint | Boot the full bundle, or attach a signed checkpoint (`--from-checkpoint`) |
| `OrganBootError: REPLAY_DIVERGENCE` | Replay of the receipts does not match the carried state (forged or stale bundle) | The bundle is dishonest or from a different lineage; do not use it |
| `OrganBootError: STATE_HASH_MISMATCH` / `RECEIPT_HASH_MISMATCH` | Content touched without re-hashing | Re-snapshot from the honest source; never patch hashes by hand |
| `NestError: DUPLICATE_NEST` | The same organ booted twice into one host | Boot once per host; the organ's own ledger travels with it |
| `DOUBLE_ENTRY_*` codes from the audit | A host credit does not pair with its organ debit (forged credit / padded rewind evidence / state mismatch) | The audit never auto-repairs; investigate the named row |
| `CHECKPOINT_SIGNATURE_INVALID` | Forged checkpoint, wrong key, or unusable key material | Re-mint with the right key; fingerprints must match |
| `CHECKPOINT_SIGNATURE_REQUIRED` | Partial custody presented without a verifier key | Pass `checkpointKey` (v2) / `checkpointKeys` (v3 rotation) |
| `E_KEY_REVOKED` | Era anchored after the key's revocation sequence | Expected enforcement; re-sign with a live key |
| `CHRONO_OP_UNMAPPABLE` / `CHRONO_FLOW_UNPAIRED` | Chrono link cannot map to an organ receipt / unpaired flow | Fix the source sheet's chain; the adapter refuses to guess |
| `KeyError: 'TYPESAFEAI_KEY'` from jev_client.py | Neither `TYPESAFE_API_KEY` nor `TYPESAFEAI_KEY` in env | Export one; values live in env, never in files |
| JEV 4xx from api.typesafe.ai | Missing key, or `criteria` omitted on score/choice | criteria is required for score (list) and choice (dict); noul's is optional |
| keyscan exits 1 | Un-receipted credential-shaped hit in HEAD/staged/worktree | Remove it; never print the value; rerun until CLEAN |

## FAQ

**Is the organ protocol just a backup format?**
No — a backup restores; an organ *boots*, meaning its history is re-proven
(chain + replay == state) before it runs, and its writes are double-entry
booked against any host. The claim is the manifest; boot is the courtroom.

**Can I skip replay for big organs?**
Yes — that is exactly what v2/v3 checkpoints buy: pay the genesis replay once
at mint time; boots after that cost O(tail). The custody gap becomes
conditional on a verified signature; unsigned gaps still refuse.

**Why does v2 custody have no signer name?**
HMAC is symmetric — every writer holds full signing power, so there is no
identity to name, and the provenance honestly records `{kind: "hmac-sha256"}`.
v3 Ed25519 splits mint/verify power and names the signer by SPKI fingerprint.

**Do the demos require network or keys?**
No. `npm run demo`, `demo:rewind`, the test suite, and all organ one-liners
are fully offline. Only `jev_client.py` / `canon_gate.py` need a TypeSafe key.

**Where is the evidence that this all works?**
`test/organ.test.mjs` (54 tests across v0–v3 including forged chains that only
replay catches), `tests/chrono-interop.test.mjs` (16 chrono/§9 tests),
`tests/revocation.test.mjs` (§11), the four receipts in `examples/receipts/`,
and the two audit receipts in `receipts/`. Suite measured 2026-10-04:
74 tests, 73 pass, 1 skip (LIVE chrono test without the sibling present).

**JEV said 0.49 on "humans have 5 senses" — is JEV broken?**
No — README's own honest example: the conventional answer (5) is wrong-adjacent
(humans have more senses), so a mid-band confidence is arguably *correct*
behavior. Use JEV as one canary in a multi-signal gate (byte-exact
polyformality, multi-model consensus, human review), never as the only signal.
