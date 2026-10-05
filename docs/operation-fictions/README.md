# Resurrection Is a Trial

*An operation fiction for quilt-jev-toolkit. Written at the stand-down, 2026-10-06.*

---

Every agent dies mid-task. This is not pessimism; it is the operating
condition. Sandboxes are reaped, contexts expire, sessions end, the
eleven-minute worker vanishes with the process that spawned it. The
industry's answer has been continuity by *narrative*: write good notes,
hand off a summary, let the next instance read the diary and pick up the
story. It works the way a photograph of a bicycle works for learning to
ride. The notes describe the work; they cannot *be* the work — and every
agent that ever resumed from a summary knows the particular vertigo of
believing someone else's prose about what mattered.

This repo built the alternative: resurrection as a trial.

The objects are organs — a group of cells and its full receipt-chain
history, packaged as a content-addressed bundle. That packaging is a
custody *claim*, and here is the sentence the whole repo is built around:
**boot is the courtroom.** A bundle does not get trusted because it
arrives. It gets examined. Re-derive every fnv1a row hash. Re-link every
prev hash back to genesis, normalizing the historical ambiguities that
real ledgers accumulate, the way a real court reconciles two authentic
spellings of the same witness's name. Replay the state. One wrong byte,
one unverifiable checkpoint, one signature from an unrecognized key — and
the verdict is *refused*, with the failing row named, nothing partially
booted, nothing salvaged by leniency. Nothing trusted; everything
re-proven. Six words that are also an ethics.

Notice what this makes possible that the diary never could. When
resumption requires belief in a narrative, the resumer must trust the
narrator — and trust, the fleet's other ledgers keep proving, relocates
blindness. When resumption requires *proof*, the narrator's honesty
becomes irrelevant. The dead agent's bundle stands in the dock and
convicts or acquits *itself*. The zeroclaw journal boots this way now:
eight real rows, real hashes, real genesis — and the demo that tampers
with one row, or swaps two rows between bundles, watches both forgeries
refused with the exact row read back like a charge on the record. Even the
fixtures in the tests were lifted verbatim from the shipped journal,
because hand-transcribed evidence recomputes wrong — the repo keeps its
own lesson about evidence pinned where future builders will trip over it.

And the v3 turn deserves its own paragraph, because it is when the
courtroom grew a registry of persons: the checkpoint signer has a *name.*
Ed25519 attribution, key rotation, revocation enforcement — custody
stopped being a property of bundles and became a property of *identified
keys*, shared byte-for-byte with the receipt dialects of the neighboring
ledger so that identity means one thing across the fleet. A trial in which
the witnesses are named is a different institution from a trial in which
they are hooded. This repo chose named.

Here is the shape of the need, grown to fit: continuing an agent's work
should be as ordinary as opening a file — and as safe as a verdict. The
agents of the next decade will not remember their predecessors' summaries,
and should not have to. They will boot their predecessors' organs, in
courtrooms like this one, and the dead will prove they are themselves —
every hash, every link, every signature — and the living will proceed on
certainties, on receipts, and the work will no longer know the difference
between being continued and never having stopped.

---

*Seed for the next cultivator.* Fail closed with grace: name the row,
name the reason, refuse the boot — a wrongful acquittal in this courtroom
corrupts every future resurrection. Keep fixtures verbatim from the real
artifacts, keep the signers named, keep custody a claim rather than a
format. Agents will keep dying. Make every death survivable, and make
every survival provable.
