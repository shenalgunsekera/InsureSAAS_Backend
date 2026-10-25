require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');

const app = express();

/* ── Firebase Admin (server-side token verification) ───────────────────────
   Credentials from FIREBASE_SERVICE_ACCOUNT (JSON string) or the standard
   GOOGLE_APPLICATION_CREDENTIALS env. If not configured, protected endpoints
   fail CLOSED (return 503) rather than run unauthenticated.                   */
let adminReady = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  } else {
    admin.initializeApp(); // uses GOOGLE_APPLICATION_CREDENTIALS if present
  }
  adminReady = true;
} catch (e) {
  console.error('Firebase Admin not initialised — protected endpoints disabled:', e.message);
}

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '64kb' })); // cap body size (anti-DoS)

/* ── Require a verified Firebase ID token ──────────────────────────────────
   CORS is not authentication (a non-browser client sends no Origin and is
   allowed through). Every state-changing endpoint must present a valid token. */
async function requireAuth(req, res, next) {
  if (!adminReady) return res.status(503).json({ error: 'Auth not configured on server' });
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authentication token' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // A valid token is not enough — anonymous quote-link visitors and website
  // customers have tokens too. Only staff (a role on users/{uid}) may proceed.
  try {
    const snap = await admin.firestore().doc(`users/${req.user.uid}`).get();
    const role = snap.exists ? snap.get('role') : null;
    if (!['admin', 'manager', 'employee'].includes(role)) return res.status(403).json({ error: 'Not allowed' });
  } catch {
    return res.status(503).json({ error: 'Auth check failed' });
  }
  next();
}

/* ── Simple in-memory rate limiter (per authenticated user) ────────────────*/
const RL = new Map(); // uid -> { count, resetAt }
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.user?.uid || req.ip;
    const now = Date.now();
    const rec = RL.get(key);
    if (!rec || now > rec.resetAt) { RL.set(key, { count: 1, resetAt: now + windowMs }); return next(); }
    if (rec.count >= max) return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    rec.count++; next();
  };
}

/* ── health ──────────────────────────────────────────────────────────── */
app.get('/health', (_, res) => res.json({ status: 'OK', service: 'InsureSAAS Backend', ts: new Date().toISOString() }));

/* ── WhatsApp Business API proxy ─────────────────────────────────────── */
app.post('/send-whatsapp', requireAuth, rateLimit(60, 60 * 1000), async (req, res) => {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken   = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
  }

  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: 'Missing required fields: to, message' });
  }

  const cleanPhone = String(to).replace(/[^0-9]/g, '');
  if (cleanPhone.length < 7) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    const https = require('https');
    const body  = JSON.stringify({
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'text',
      text: { body: message, preview_url: false },
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'graph.facebook.com',
        path:     `/v20.0/${phoneNumberId}/messages`,
        method:   'POST',
        headers:  {
          'Authorization':  `Bearer ${accessToken}`,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req2 = https.request(options, (r) => {
        let raw = '';
        r.on('data', c => raw += c);
        r.on('end',  () => {
          let parsed = {};
          try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
          resolve({ status: r.statusCode, body: parsed });
        });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (result.status >= 400) {
      return res.status(result.status).json({ error: result.body?.error?.message || 'WhatsApp API error', details: result.body });
    }
    res.json({ success: true, message_id: result.body?.messages?.[0]?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`InsureSAAS backend running on port ${PORT}`);
});
