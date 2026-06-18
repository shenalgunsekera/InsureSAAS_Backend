require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());

/* ── health ──────────────────────────────────────────────────────────── */
app.get('/health', (_, res) => res.json({ status: 'OK', service: 'InsureSAAS Backend', ts: new Date().toISOString() }));

/* ── WhatsApp Business API proxy ─────────────────────────────────────── */
app.post('/send-whatsapp', async (req, res) => {
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
        r.on('end',  () => resolve({ status: r.statusCode, body: JSON.parse(raw) }));
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
