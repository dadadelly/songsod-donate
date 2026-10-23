// SONG SOD Donate — v1.2.1
// หน้าโดเนท + Overlay แจ้งเตือนแบบเรียลไทม์ (Server-Sent Events)
// v1.1 = QR PromptPay ของเราเอง + แอดมินกดอนุมัติก่อนเด้ง
//        (ถ้ายังไม่ตั้ง PROMPTPAY_ID จะเป็นโหมดทดสอบเหมือน v1.0)
// v1.2 = ต่อ TikTok LIVE: อ่านคอมเมนต์ + ขอบคุณคนกดติดตาม (overlay: /tiktok.html)
// v1.2.1 = เสียงอ่านเสถียรขึ้น (ลองหลายแบบ + แบ่งข้อความยาว) + ปุ่มตรวจเสียงอ่านในหน้า admin
// ใช้ Node ล้วน ไม่ต้อง npm install

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('./vendor/QRCode');                       // ตัวสร้าง QR (MIT)
const QRErrorCorrectLevel = require('./vendor/QRCode/QRErrorCorrectLevel');

const VERSION = 'v1.2.1';
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';
// เบอร์โทร (10 หลัก) / เลขบัตรประชาชน (13 หลัก) / e-Wallet ID (15 หลัก) ที่ผูก PromptPay
const PROMPTPAY_ID = String(process.env.PROMPTPAY_ID || '').replace(/\D/g, '');
const PROMPTPAY_NAME = process.env.PROMPTPAY_NAME || '';   // ชื่อบัญชี ไว้โชว์ให้คนดูมั่นใจ
const TEST_MODE = !PROMPTPAY_ID;                           // ยังไม่ใส่ PromptPay = โหมดทดสอบ
const PENDING_TTL = 30 * 60 * 1000;                        // รอโอน/รออนุมัติได้ 30 นาที
const MIN_AMOUNT = Number(process.env.MIN_AMOUNT || 10);
const MAX_AMOUNT = Number(process.env.MAX_AMOUNT || 100000);
const STREAMER_NAME = process.env.STREAMER_NAME || 'SONG SOD';
const MAX_MSG = 150;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- กรองคำหยาบ ----------
const DEFAULT_BAD = ['ควย', 'เหี้ย', 'เหี่ย', 'สัส', 'สัด', 'หี', 'แตด', 'เย็ด', 'จัญไร', 'ระยำ', 'fuck', 'shit', 'bitch', 'dick', 'pussy'];
const BAD_WORDS = DEFAULT_BAD.concat(
  (process.env.BAD_WORDS || '').split(',').map(s => s.trim()).filter(Boolean)
);
const BAD_RE = BAD_WORDS.map(w => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));

function cleanText(text, maxLen) {
  let t = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')         // ตัวอักษรควบคุม
    .replace(/https?:\/\/\S+|www\.\S+/gi, '[ลิงก์]') // ห้ามโฆษณาลิงก์
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
  for (const re of BAD_RE) t = t.replace(re, '***');
  return t;
}

// ---------- เก็บรายการล่าสุด (ในหน่วยความจำ) ----------
const recent = [];               // โดเนทล่าสุด 50 รายการ
const ttsText = new Map();       // id -> ข้อความที่จะอ่าน (กันคนเอา /tts ไปใช้มั่ว)

function remember(d) {
  recent.unshift(d);
  if (recent.length > 50) recent.pop();
  addTts(d.id, d.speech);
}

function addTts(id, speech) {
  ttsText.set(id, speech);
  if (ttsText.size > 300) ttsText.delete(ttsText.keys().next().value);
}

// ---------- PromptPay QR (มาตรฐาน EMVCo / Thai QR) ----------
function tlv(id, value) { return id + String(value.length).padStart(2, '0') + value; }

function crc16(str) {           // CRC-16/CCITT-FALSE
  let crc = 0xffff;
  for (const ch of Buffer.from(str, 'ascii')) {
    crc ^= ch << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function promptpayPayload(id, amount) {
  let target;
  if (id.length >= 15) target = tlv('03', id);                              // e-Wallet
  else if (id.length >= 13) target = tlv('02', id);                         // เลขบัตรประชาชน / ภาษี
  else target = tlv('01', ('0000000000000' + id.replace(/^0/, '66')).slice(-13)); // เบอร์โทร
  let s = tlv('00', '01') +
    tlv('01', amount ? '12' : '11') +
    tlv('29', tlv('00', 'A000000677010111') + target) +
    tlv('58', 'TH') +
    tlv('53', '764') +
    (amount ? tlv('54', Number(amount).toFixed(2)) : '') +
    '6304';
  return s + crc16(s);
}

function qrSvg(text) {           // วาด QR เป็นรูป SVG
  const q = new QRCode(-1, QRErrorCorrectLevel.M);
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), pad = 4, size = n + pad * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// ---------- รายการรออนุมัติ ----------
const pending = new Map();       // id -> { d, at, paid }
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of pending) if (t - v.at > PENDING_TTL) pending.delete(k);
}, 60000);

// ---------- TikTok LIVE: อ่านคอมเมนต์ + ขอบคุณคนกดติดตาม ----------
// ใช้ tiktok-live-connector (ไม่ใช่ API ทางการของ TikTok — TikTok เปลี่ยนระบบเมื่อไหร่อาจใช้ไม่ได้ชั่วคราว)
const TIKTOK_USERNAME = String(process.env.TIKTOK_USERNAME || '').trim().replace(/^@/, '');
const EULER_API_KEY = process.env.EULER_API_KEY || '';       // ไม่ใส่ก็ได้ ใส่แล้วโดนจำกัดน้อยลง
const FOLLOW_TEXT = process.env.FOLLOW_TEXT || 'ขอบคุณ {name} ที่กดติดตามนะคะ';
const CHAT_TEXT = process.env.CHAT_TEXT || '{name} บอกว่า {text}';
const CHAT_COOLDOWN = Number(process.env.CHAT_COOLDOWN || 8) * 1000; // คนเดิมพิมพ์รัว ๆ อ่านแค่ทุก 8 วิ
const RETRY_MS = 90 * 1000;

const tt = {
  conn: null, username: TIKTOK_USERNAME, status: 'off', error: '', roomId: null,
  readChat: process.env.READ_CHAT !== 'false', readFollow: process.env.READ_FOLLOW !== 'false',
  wantOn: false, retry: null, followed: new Set(), lastChat: new Map(), counts: { chat: 0, follow: 0 }
};
setInterval(() => { const t = Date.now(); for (const [k, v] of tt.lastChat) if (t - v > 60000) tt.lastChat.delete(k); }, 60000);

const fillText = (tpl, name, text = '') => tpl.replace(/\{name\}/g, name).replace(/\{text\}/g, text);
const speakable = t => t.replace(/\*+|\[ลิงก์\]/g, ' ').replace(/\s+/g, ' ').trim();

function emitSpeech(type, name, text, speech) {
  const id = crypto.randomUUID();
  speech = speakable(speech);
  addTts(id, speech);
  broadcast(type, { id, name, text, speech, at: new Date().toISOString() });
}

function onChat(data) {
  if (!tt.readChat) return;
  const uid = String(data?.user?.uniqueId || '');
  const now = Date.now();
  if (now - (tt.lastChat.get(uid) || 0) < CHAT_COOLDOWN) return;
  const name = cleanText(data?.user?.nickname || uid, 30) || 'ใครสักคน';
  const text = cleanText(data?.comment, 100);
  if (!speakable(text)) return;                     // ไม่มีอะไรให้อ่าน (เช่น มีแต่คำหยาบ/ลิงก์)
  tt.lastChat.set(uid, now);
  tt.counts.chat++;
  emitSpeech('chat', name, text, fillText(CHAT_TEXT, name, text));
}

function onFollow(data) {
  if (!tt.readFollow) return;
  const uid = String(data?.user?.uniqueId || '');
  if (uid && tt.followed.has(uid)) return;          // คนเดิมกดซ้ำในไลฟ์เดียวกัน ขอบคุณครั้งเดียว
  if (uid) tt.followed.add(uid);
  const name = cleanText(data?.user?.nickname || uid, 30) || 'ใครสักคน';
  tt.counts.follow++;
  emitSpeech('follow', name, '', fillText(FOLLOW_TEXT, name));
}

function friendlyError(e) {
  const msg = String(e?.message || e || '');
  if (/offline|not live|ended|LIVE has ended|isn't online|UserOffline/i.test(msg)) return 'ยังไม่ได้เริ่มไลฟ์ — เริ่มไลฟ์แล้วระบบจะต่อเองภายใน 1–2 นาที';
  if (/429|rate/i.test(msg)) return 'เชื่อมต่อบ่อยเกินไป รอสักครู่ (หรือใส่ EULER_API_KEY)';
  if (/not found|user_not_found|19881007/i.test(msg)) return 'ไม่พบชื่อผู้ใช้นี้ เช็ก @username อีกครั้ง';
  return 'เชื่อมต่อไม่สำเร็จ: ' + msg.slice(0, 120);
}

function scheduleRetry() {
  clearTimeout(tt.retry);
  if (tt.wantOn) tt.retry = setTimeout(() => ttConnect(tt.username), RETRY_MS);
}

function ttDisconnect(stop = true) {
  if (stop) { tt.wantOn = false; tt.status = 'off'; tt.error = ''; tt.roomId = null; }
  clearTimeout(tt.retry);
  const c = tt.conn;
  tt.conn = null;
  if (c) { try { c.disconnect(); } catch {} }
}

async function ttConnect(username) {
  username = String(username || '').trim().replace(/^@/, '');
  if (!username) { tt.status = 'error'; tt.error = 'ยังไม่ได้ใส่ชื่อผู้ใช้ TikTok'; return; }
  ttDisconnect(false);
  Object.assign(tt, { username, wantOn: true, status: 'connecting', error: '', roomId: null });

  let mod;
  try { mod = await import('tiktok-live-connector'); }
  catch { tt.status = 'error'; tt.error = 'ยังไม่ได้ติดตั้ง tiktok-live-connector (Build Command ต้องเป็น npm install)'; tt.wantOn = false; return; }

  const Conn = mod.TikTokLiveConnection || mod.default?.TikTokLiveConnection;
  const EV = mod.WebcastEvent || mod.default?.WebcastEvent || {};
  const conn = new Conn(username, EULER_API_KEY ? { signApiKey: EULER_API_KEY } : {});
  tt.conn = conn;
  conn.on(EV.CHAT || 'chat', onChat);
  conn.on(EV.FOLLOW || 'follow', onFollow);
  conn.on('error', e => console.error('[tiktok]', e?.message || e));
  conn.on('disconnected', () => {
    if (tt.conn !== conn) return;
    tt.conn = null; tt.status = 'retry'; tt.error = 'หลุดการเชื่อมต่อ กำลังลองใหม่…';
    scheduleRetry();
  });

  try {
    const st = await conn.connect();
    if (tt.conn !== conn) return;
    tt.status = 'live'; tt.roomId = st?.roomId || null; tt.followed.clear();
    console.log('[tiktok] connected @' + username, tt.roomId);
  } catch (e) {
    if (tt.conn !== conn) return;
    tt.conn = null; tt.status = 'retry'; tt.error = friendlyError(e);
    scheduleRetry();
  }
}

// ---------- เสียงอ่านภาษาไทย (Google Translate TTS — ไม่ใช่ API ทางการ) ----------
const ttsStat = { ok: 0, fail: 0, last: '' };

function splitText(text, max = 180) {          // Google รับได้ครั้งละไม่เกิน ~200 ตัว
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

async function ttsChunk(text) {
  let lastErr = '';
  for (const client of ['tw-ob', 'gtx']) {
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=th&total=1&idx=0' +
      `&textlen=${text.length}&client=${client}&q=` + encodeURIComponent(text);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', Referer: 'https://translate.google.com/' },
        signal: AbortSignal.timeout(8000)
      });
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.ok && buf.length > 500) return buf;
      lastErr = `${client}: HTTP ${r.status}`;
    } catch (e) {
      lastErr = `${client}: ${e.message}`;
    }
  }
  throw new Error(lastErr);
}

async function ttsAudio(text) {
  try {
    const parts = [];
    for (const chunk of splitText(text)) parts.push(await ttsChunk(chunk));
    ttsStat.ok++; ttsStat.last = 'ok';
    return Buffer.concat(parts);              // ต่อไฟล์ mp3 หลายท่อนเป็นอันเดียว
  } catch (e) {
    ttsStat.fail++; ttsStat.last = e.message;
    console.error('[tts] failed:', e.message);
    return null;
  }
}

// ---------- ส่งสัญญาณไป Overlay (SSE) ----------
const clients = new Set();

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of clients) r.write(msg);
}
setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 25000);

function makeDonation({ name, amount, message, method, test }) {
  const cleanName = cleanText(name, 30) || 'ไม่ระบุชื่อ';
  const cleanMsg = cleanText(message, MAX_MSG);
  const amt = Math.round(Number(amount) * 100) / 100;
  return {
    id: crypto.randomUUID(),
    name: cleanName,
    amount: amt,
    message: cleanMsg,
    method: ['promptpay', 'truemoney', 'test'].includes(method) ? method : 'test',
    test: !!test,
    // ไม่อ่าน *** และ [ลิงก์] ออกเสียง
    speech: (`${cleanName} โดเนท ${amt} บาท ` + cleanMsg).replace(/\*+|\[ลิงก์\]/g, ' ').replace(/\s+/g, ' ').trim(),
    at: new Date().toISOString()
  };
}

function fire(d) { remember(d); broadcast('donate', d); }

const validAmount = a => { const n = Number(a); return Number.isFinite(n) && n >= MIN_AMOUNT && n <= MAX_AMOUNT; };

function isAdmin(req) {
  const a = Buffer.from(String(req.headers['x-admin-key'] || ''));
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- ตัวช่วย HTTP ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(resolve => {
    let size = 0, chunks = [];
    req.on('data', c => { size += c.length; if (size > 20000) req.destroy(); else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function clientIp(req) {  // บน Render IP จริงอยู่ใน x-forwarded-for
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- เส้นทาง ----------
const lastHit = new Map(); // กันกดรัว ๆ (ต่อ IP)
setInterval(() => { const t = Date.now(); for (const [k, v] of lastHit) if (t - v > 60000) lastHit.delete(k); }, 60000);

const seenEvents = new Set(); // v2: กัน webhook ซ้ำ

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  const m = req.method;

  try {
    if (m === 'GET' && pathname === '/') { res.writeHead(302, { Location: '/donate.html' }); return res.end(); }

    if (m === 'GET' && pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (m === 'GET' && pathname === '/api/config') {
      return json(res, 200, { version: VERSION, testMode: TEST_MODE, payName: PROMPTPAY_NAME, minAmount: MIN_AMOUNT, maxAmount: MAX_AMOUNT, maxMsg: MAX_MSG, streamer: STREAMER_NAME });
    }

    // คนดูกดโดเนท
    if (m === 'POST' && pathname === '/api/donate') {
      const ip = clientIp(req), now = Date.now();
      if (now - (lastHit.get(ip) || 0) < 5000) return json(res, 429, { ok: false, error: 'กดถี่เกินไป รอสักครู่นะ' });
      lastHit.set(ip, now);
      const b = await readBody(req);
      if (!validAmount(b.amount)) return json(res, 400, { ok: false, error: `จำนวนเงินต้องอยู่ระหว่าง ${MIN_AMOUNT}–${MAX_AMOUNT} บาท` });
      if (TEST_MODE) {
        const d = makeDonation({ ...b, test: true });
        fire(d);
        return json(res, 200, { ok: true, testMode: true, id: d.id });
      }
      // สร้าง QR PromptPay ตามยอด แล้วเก็บไว้รอแอดมินอนุมัติ
      if (pending.size >= 200) return json(res, 503, { ok: false, error: 'คิวเต็ม ลองใหม่อีกสักครู่นะ' });
      const d = makeDonation({ ...b, method: 'promptpay', test: false });
      pending.set(d.id, { d, at: now, paid: false });
      return json(res, 200, { ok: true, testMode: false, id: d.id, amount: d.amount, qr: '/qr/' + d.id, payName: PROMPTPAY_NAME });
    }

    // รูป QR PromptPay ของรายการนั้น ๆ
    if (m === 'GET' && pathname.startsWith('/qr/')) {
      const p = pending.get(pathname.slice(4));
      if (!p) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(qrSvg(promptpayPayload(PROMPTPAY_ID, p.d.amount)));
    }

    // คนดูกด "โอนแล้ว"
    if (m === 'POST' && pathname === '/api/paid') {
      const b = await readBody(req);
      const p = pending.get(String(b.id || ''));
      if (!p) return json(res, 404, { ok: false, error: 'ไม่พบรายการ หรือหมดเวลาแล้ว' });
      p.paid = true;
      return json(res, 200, { ok: true });
    }

    // ---- แอดมิน ----
    if (['/api/test', '/api/skip', '/api/recent', '/api/pending', '/api/approve', '/api/reject', '/api/tts-check'].includes(pathname) || pathname.startsWith('/api/tiktok/')) {
      if (!isAdmin(req)) return json(res, 401, { ok: false, error: 'รหัสแอดมินไม่ถูกต้อง' });

      if (m === 'POST' && pathname === '/api/test') {
        const b = await readBody(req);
        const d = makeDonation({
          name: b.name || 'คนดูทดสอบ',
          amount: Number(b.amount) > 0 ? b.amount : 100,
          message: b.message ?? 'ทดสอบระบบโดเนทค่ะ',
          method: 'test', test: true
        });
        fire(d);
        return json(res, 200, { ok: true, id: d.id });
      }
      if (m === 'POST' && pathname === '/api/skip') { broadcast('skip', {}); return json(res, 200, { ok: true }); }
      if (m === 'GET' && pathname === '/api/recent') return json(res, 200, { ok: true, items: recent, overlays: clients.size });

      // ตรวจว่าเซิร์ฟเวอร์ดึงเสียงอ่านจาก Google ได้มั้ย
      if (m === 'GET' && pathname === '/api/tts-check') {
        const audio = await ttsAudio('ทดสอบเสียงอ่านภาษาไทย');
        return json(res, 200, { ok: true, works: !!audio, bytes: audio ? audio.length : 0, error: audio ? '' : ttsStat.last, stats: ttsStat });
      }

      // ---- TikTok LIVE ----
      if (m === 'GET' && pathname === '/api/tiktok/status') {
        const { username, status, error, roomId, readChat, readFollow, counts } = tt;
        return json(res, 200, { ok: true, username, status, error, roomId, readChat, readFollow, counts });
      }
      if (m === 'POST' && pathname === '/api/tiktok/connect') {
        const b = await readBody(req);
        ttConnect(b.username || tt.username);          // ไม่ต้องรอ ให้หน้า admin เช็กสถานะเอง
        return json(res, 200, { ok: true });
      }
      if (m === 'POST' && pathname === '/api/tiktok/disconnect') { ttDisconnect(true); return json(res, 200, { ok: true }); }
      if (m === 'POST' && pathname === '/api/tiktok/settings') {
        const b = await readBody(req);
        if (typeof b.readChat === 'boolean') tt.readChat = b.readChat;
        if (typeof b.readFollow === 'boolean') tt.readFollow = b.readFollow;
        return json(res, 200, { ok: true, readChat: tt.readChat, readFollow: tt.readFollow });
      }
      if (m === 'POST' && pathname === '/api/tiktok/test') {
        const b = await readBody(req);
        if (b.type === 'follow') {
          const name = cleanText(b.name, 30) || 'คนดูทดสอบ';
          emitSpeech('follow', name, '', fillText(FOLLOW_TEXT, name));
        } else {
          const name = cleanText(b.name, 30) || 'คนดูทดสอบ';
          const text = cleanText(b.text, 100) || 'สวัสดีค่ะ';
          emitSpeech('chat', name, text, fillText(CHAT_TEXT, name, text));
        }
        return json(res, 200, { ok: true });
      }

      // รายการรออนุมัติ (แจ้งโอนแล้วขึ้นก่อน)
      if (m === 'GET' && pathname === '/api/pending') {
        const items = [...pending.values()]
          .sort((a, b) => (b.paid - a.paid) || (b.at - a.at))
          .map(p => ({ ...p.d, paid: p.paid }));
        return json(res, 200, { ok: true, items, testMode: TEST_MODE });
      }
      // อนุมัติ = เช็กในแอปธนาคารแล้วว่าเงินเข้าจริง → เด้งบนจอ
      if (m === 'POST' && (pathname === '/api/approve' || pathname === '/api/reject')) {
        const b = await readBody(req);
        const p = pending.get(String(b.id || ''));
        if (!p) return json(res, 404, { ok: false, error: 'ไม่พบรายการ (อาจอนุมัติไปแล้ว)' });
        pending.delete(p.d.id);
        if (pathname === '/api/approve') fire({ ...p.d, at: new Date().toISOString() });
        return json(res, 200, { ok: true });
      }
    }

    // อ่านข้อความเป็นเสียงไทย (ได้เฉพาะข้อความที่ระบบสร้างเอง)
    if (m === 'GET' && pathname.startsWith('/tts/')) {
      const text = ttsText.get(pathname.slice(5));
      if (!text) { res.writeHead(404); return res.end(); }
      const audio = await ttsAudio(text);
      if (!audio) { res.writeHead(502); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
      return res.end(audio);
    }

    // v2: Opn webhook (ยังไม่เปิดใช้) — โครงไว้ก่อน
    if (m === 'POST' && pathname === '/webhook/opn') {
      const ev = await readBody(req);
      if (ev.id && !seenEvents.has(ev.id)) {
        seenEvents.add(ev.id);
        // v2: ดึง charge จาก Opn API ด้วย Secret Key เพื่อยืนยัน status === 'successful' แล้วค่อย fire()
        console.log('[opn webhook]', ev.key, ev.id);
      }
      res.writeHead(200); return res.end();
    }

    if (m === 'GET' || m === 'HEAD') return serveStatic(req, res, pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500); }
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`SONG SOD Donate ${VERSION} running on :${PORT}  (${TEST_MODE ? 'testMode' : 'PromptPay mode'})`);
  if (TIKTOK_USERNAME) ttConnect(TIKTOK_USERNAME);   // มีชื่อ TikTok ใน Render → ต่อเองอัตโนมัติ
  if (ADMIN_KEY === 'changeme') console.log('⚠️  ตั้ง ADMIN_KEY ก่อนขึ้นออนไลน์จริงนะ');
});
