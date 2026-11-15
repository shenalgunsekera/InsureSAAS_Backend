// D110 recovery test: restore an InsureSAAS backup into the Firebase EMULATOR (never
// production), read everything back and prove records and their links survived.
//   firebase emulators:exec --only firestore "node scripts/recovery-test.cjs backup.zip"
const fs = require('fs');
const JSZip = require('jszip');
const admin = require('firebase-admin');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set. This test only restores into the emulator.'); process.exit(2); }
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/recovery-test.cjs <insuresaas_backup.zip>'); process.exit(2); }

const revive = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && v.__ts) return admin.firestore.Timestamp.fromDate(new Date(v.__ts));
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
  return v;
};
const flat = (v) => {
  if (v instanceof admin.firestore.Timestamp) return { __ts: v.toDate().toISOString() };
  if (Array.isArray(v)) return v.map(flat);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, flat(v[k])]));
  return v;
};
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);

(async () => {
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'insuresaas-recovery-test' });
  const db = admin.firestore();
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const entry = zip.file('premium/collections.json');
  if (!entry) { console.error('Backup has no premium/collections.json (taken before v2).'); process.exit(1); }
  const { collections } = JSON.parse(await entry.async('string'));
  const t0 = Date.now();
  let written = 0;
  for (const [c, docs] of Object.entries(collections)) {
    for (let i = 0; i < docs.length; i += 400) {
      const b = db.batch();
      for (const d of docs.slice(i, i + 400)) { const { id, ...rest } = d; b.set(db.collection(c).doc(id), revive(rest)); written++; }
      await b.commit();
    }
  }
  const restored = {};
  for (const c of Object.keys(collections)) restored[c] = (await db.collection(c).get()).docs.map(d => ({ id: d.id, ...flat(d.data()) }));
  const diffs = [];
  for (const [c, docs] of Object.entries(collections)) {
    const back = new Map(restored[c].map(r => [r.id, r]));
    if (back.size !== docs.length) diffs.push(`${c}: ${docs.length} in backup, ${back.size} restored`);
    for (const d of docs) { const r = back.get(d.id); if (!r) diffs.push(`${c}/${d.id} missing`); else if (JSON.stringify(sortKeys(d)) !== JSON.stringify(sortKeys(r))) diffs.push(`${c}/${d.id} differs`); }
  }
  const pol = new Set((restored.clients || []).map(p => p.id));
  const links = [];
  for (const j of restored.acct_journal || []) if (j.policy_id && !pol.has(j.policy_id)) links.push(`journal ${j.id} → missing policy ${j.policy_id}`);
  for (const s of restored.acct_settlements || []) for (const l of s.lines || []) if (!pol.has(l.policy_id)) links.push(`settlement ${s.id} → missing policy ${l.policy_id}`);
  for (const p of restored.clients || []) if (p.renewal_of && !pol.has(p.renewal_of)) links.push(`policy ${p.policy_no || p.id} renews missing ${p.renewal_of}`);
  const report = { restored_at: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, documents: written, collections: Object.fromEntries(Object.entries(restored).map(([c, d]) => [c, d.length])), content_differences: diffs, broken_links: links, passed: !diffs.length && !links.length };
  fs.writeFileSync('recovery-test-report.json', JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ passed: report.passed, documents: written, differences: diffs.length, broken_links: links.length, seconds: report.seconds }));
  process.exit(report.passed ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
