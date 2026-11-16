// D022 / AUT-02: insurer replies by WhatsApp. Meta Cloud API webhook → match the
// sender to an approved insurer contact and its open request → read the terms →
// a clear reply joins the request's responses; anything unmatched, ambiguous,
// late or conflicting goes to whatsapp_inbox for the executive.
const crypto = require('crypto');
const express = require('express');
const { extractDocument } = require('./integrations');

const digits = (s) => { let d = String(s || '').replace(/[^0-9]/g, ''); if (d.startsWith('0') && d.length === 10) d = `94${d.slice(1)}`; return d; };
const TERMS = [
  { key: 'quote_reference', label: 'Our quotation request reference (e.g. MT-12345)' },
  { key: 'premium', label: 'Total premium quoted' },
  { key: 'basic_premium', label: 'Basic premium' },
  { key: 'deductible', label: 'Deductible' },
  { key: 'excesses', label: 'Excess' },
  { key: 'commission_type', label: 'Commission type', hint: 'Standard or Special' },
  { key: 'validity_days', label: 'Quotation validity in days' },
  { key: 'declined', label: 'Does the insurer decline to quote?', hint: 'yes or no' },
  { key: 'notes', label: 'Conditions or notes' },
];

async function graph(path) {
  const r = await fetch(`https://graph.facebook.com/v20.0/${path}`, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } });
  if (!r.ok) throw new Error(`Graph ${r.status}`);
  return r;
}
async function mediaBase64(id) {
  const meta = await (await graph(id)).json();
  const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } });
  if (!r.ok) throw new Error(`Attachment download failed (HTTP ${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) throw new Error('Attachment larger than 15 MB');
  return { base64: buf.toString('base64'), media_type: meta.mime_type };
}

async function handleMessage(db, admin, msg, contactName) {
  const from = digits(msg.from);
  const at = new Date(Number(msg.timestamp || Date.now() / 1000) * 1000).toISOString();
  const text = msg.text?.body || msg.document?.caption || msg.image?.caption || '';
  const inbox = { from, from_name: contactName || '', at, wa_id: msg.id, text, media: msg.document || msg.image ? { id: (msg.document || msg.image).id, name: msg.document?.filename || 'image', mime: (msg.document || msg.image).mime_type } : null, status: 'Needs review', reason: '' };
  const idemp = db.doc(`whatsapp_inbox/${msg.id}`);
  // Meta retries deliveries (sometimes concurrently) — claim the message id atomically, process once
  try { await idemp.create({ ...inbox, status: 'Processing' }); } catch (e) { if (e.code === 6 || /already exists/i.test(e.message)) return; throw e; }
  // 1. approved insurer contact
  const contacts = (await db.collection('insurance_companies').get()).docs.filter(d => digits(d.get('whatsapp')) === from);
  if (!contacts.length) { await idemp.set({ ...inbox, reason: 'Sender is not an approved insurer WhatsApp contact' }); return; }
  const companyIds = new Set(contacts.map(d => d.id));
  const companyName = contacts[0].get('name');
  // 2. open requests sent to that contact
  const open = (await db.collection('quotes').where('status', 'in', ['sent', 'partial']).get()).docs
    .filter(d => !d.get('closed_at') && (d.get('sent_to') || []).some(s => companyIds.has(s.company_id)));
  // 3. read the terms (text and/or attachment)
  let terms = null;
  try {
    terms = inbox.media
      ? await extractDocument({ docType: 'Insurer quotation reply', fields: TERMS, file: await mediaBase64(inbox.media.id) })
      : await extractTextTerms(text);
  } catch (e) { inbox.extract_error = e.message; }
  const val = (k) => (terms?.fields || []).find(f => f.key === k) || {};
  const ref = String(val('quote_reference').value || '').trim().toUpperCase();
  let target = open.filter(d => ref && String(d.get('reference') || '').toUpperCase() === ref);
  // The reference is often only in the message or caption, not in the attached quotation
  if (!target.length) {
    const said = text.toUpperCase();
    target = open.filter(d => { const r = String(d.get('reference') || '').toUpperCase(); return r && new RegExp(`(^|[^A-Z0-9])${r.replace(/[^A-Z0-9]/g, m => `\\${m}`)}([^A-Z0-9]|$)`).test(said); });
  }
  if (!target.length && open.length === 1) target = open;
  inbox.company_name = companyName; inbox.candidates = open.map(d => d.id); inbox.terms = terms ? terms.fields : null;
  if (target.length !== 1) { await idemp.set({ ...inbox, reason: open.length ? `Matches ${open.length} open requests — choose the request` : 'No open request for this insurer' }); return; }
  const qref = target[0].ref; const q = target[0].data();
  const sent = (q.sent_to || []).find(s => companyIds.has(s.company_id));
  const ext = (q.extensions || {})[sent.company_id];
  const cutoff = ext || q.cutoff_at;
  if (cutoff && new Date(at) > new Date(cutoff)) { await idemp.set({ ...inbox, quote_id: qref.id, reason: 'Received after the response deadline' }); return; }
  const declined = /^y/i.test(String(val('declined').value || ''));
  const premium = Number(String(val('premium').value || '').replace(/[^0-9.]/g, '')) || 0;
  const unclear = !declined && (!premium || ['low', 'not_found'].includes(val('premium').confidence)) || (terms?.conflicts || []).length;
  if (unclear) { await idemp.set({ ...inbox, quote_id: qref.id, reason: (terms?.conflicts || []).length ? `Conflicting terms: ${terms.conflicts.join('; ')}` : 'Terms not clear enough to enter automatically' }); return; }
  const response = {
    id: `${sent.company_id}_wa_${msg.id}`, company_id: sent.company_id, company_name: sent.company_name, source: 'whatsapp', whatsapp_from: from, whatsapp_message_id: msg.id,
    premium, basic_premium: Number(String(val('basic_premium').value || '').replace(/[^0-9.]/g, '')) || 0, deductible: val('deductible').value || '', excesses: val('excesses').value || '',
    commission_type: val('commission_type').value || '', validity_days: val('validity_days').value || '', notes: [val('notes').value, text].filter(Boolean).join('\n'),
    declined, ...(declined ? { decline_reason: val('notes').value || 'Declined by WhatsApp' } : {}), submitted_at: at, request_version: q.request_version || 1,
    extracted: (terms?.fields || []).map(f => ({ key: f.key, value: f.value, confidence: f.confidence, source_text: f.source_text })),
  };
  // The one-confirmed-quote-per-insurer rule applies in Compare; keep every reply.
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(qref);
    if (fresh.get('closed_at')) throw new Error('closed');
    tx.update(qref, { responses: [...(fresh.get('responses') || []), response], status: 'partial', updated_at: new Date().toISOString() });
    tx.set(idemp, { ...inbox, quote_id: qref.id, status: 'Entered', response_id: response.id });
  }).catch(async () => { await idemp.set({ ...inbox, quote_id: qref.id, reason: 'Request closed before the reply was processed' }); });
}

async function extractTextTerms(text) {
  return extractDocument({ docType: 'Insurer quotation reply (WhatsApp text)', fields: TERMS, file: { text } });
}

function mountWhatsAppWebhook(app, admin) {
  // Raw body is needed to verify Meta's X-Hub-Signature-256 — mount before express.json.
  app.get('/webhooks/whatsapp', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
    res.sendStatus(403);
  });
  app.post('/webhooks/whatsapp', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret) return res.sendStatus(503);
    const sig = String(req.headers['x-hub-signature-256'] || '');
    const want = `sha256=${crypto.createHmac('sha256', secret).update(req.body).digest('hex')}`;
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return res.sendStatus(401);
    res.sendStatus(200); // acknowledge fast; Meta retries otherwise
    try {
      const body = JSON.parse(req.body.toString('utf8'));
      const db = admin.firestore();
      for (const entry of body.entry || []) for (const ch of entry.changes || []) {
        const v = ch.value || {};
        const names = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile?.name]));
        for (const m of v.messages || []) await handleMessage(db, admin, m, names[m.from]).catch(async (e) => {
          console.error('WhatsApp message failed:', e.message);
          // never leave a claimed message hidden in 'Processing'
          if (m.id) await db.doc(`whatsapp_inbox/${m.id}`).set({ status: 'Needs review', reason: `Could not process automatically: ${e.message}` }, { merge: true }).catch(() => {});
        });
      }
    } catch (e) { console.error('WhatsApp webhook error:', e.message); }
  });
}

module.exports = { mountWhatsAppWebhook, digits, handleMessage };
