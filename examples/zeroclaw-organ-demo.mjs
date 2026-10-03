import { bootZeroclaw, snapshotZeroclaw, loadZeroclawJournal, fnv1a64, pyCanon } from "../src/organ/zeroclawOps.mjs";

// 1. byte-compat canary: fnv1a64 + pyCanon must reproduce zeroclaw.py exactly
const probe = { order: "demo", ts: "2026-10-03T00:00:00Z", note: "héllo→世界\n" };
const jsHash = fnv1a64(pyCanon(probe));
console.log("fnv1a64 probe:", jsHash);

const rows = await loadZeroclawJournal("/tmp/fleet-seeds/tools/zeroclaw/zeroclaw-journal.jsonl");
console.log("loaded rows:", rows.length, "tip:", rows[rows.length - 1].row_hash);

const organ = bootZeroclaw(rows, { name: "fleet-zeroclaw" });
console.log("BOOT OK organ:", organ.manifest.organId);
console.log("custody:", JSON.stringify(organ.custody));
console.log("state:", JSON.stringify(organ.cells.journal.value).slice(0, 160));

// bundle form: snapshot → re-boot from the bundle's own receipts (courtroom on carried bytes)
const bundle = snapshotZeroclaw(rows, { name: "fleet-zeroclaw" });
const organ2 = bootZeroclaw(rows, { name: "fleet-zeroclaw", bundle });
console.log("BUNDLE RE-PROOF OK:", organ2.manifest.manifestHash === organ.manifest.manifestHash);

// tamper: one field, hash not fixed → ZC_ROW_HASH_MISMATCH
const tampered = rows.map((r, i) => i === 3 ? { ...r, usage: { ...r.usage, tokens: 999 } } : r);
try { bootZeroclaw(tampered); console.log("TAMPER: NOT CAUGHT (bad)"); }
catch (e) { console.log("TAMPER REFUSED:", e.message.slice(0, 80)); }

// chain break: swap rows 1 and 2
const swapped = [rows[0], rows[2], rows[1], ...rows.slice(3)];
try { bootZeroclaw(swapped); console.log("SWAP: NOT CAUGHT (bad)"); }
catch (e) { console.log("SWAP REFUSED:", e.message.slice(0, 80)); }
