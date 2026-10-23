// SONG SOD Donate — v1.0.0
// หน้าโดเนท + Overlay แจ้งเตือนแบบเรียลไทม์ (Server-Sent Events)
// v1 = โหมดทดสอบ (ยังไม่รับเงินจริง)  |  v2 = ต่อ Opn (PromptPay / TrueMoney)
// ใช้ Node ล้วน ไม่ต้อง npm install

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 'v1.0.0';
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';
const TEST_MODE = process.env.TEST_MODE !== 'false';       // ค่าเริ่มต้น = โหมดทดสอบ
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
  ttsText.set(d.id, d.speech);
  if (ttsText.size > 100) ttsText.delete(ttsText.keys().next().value);
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
      return json(res, 200, { version: VERSION, testMode: TEST_MODE, minAmount: MIN_AMOUNT, maxAmount: MAX_AMOUNT, maxMsg: MAX_MSG, streamer: STREAMER_NAME });
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
      // v2: สร้าง charge กับ Opn แล้วส่ง QR / ลิงก์จ่ายเงินกลับไป
      return json(res, 503, { ok: false, error: 'ระบบรับเงินจริงยังไม่เปิด (มาใน v2)' });
    }

    // ---- แอดมิน ----
    if (pathname === '/api/test' || pathname === '/api/skip' || pathname === '/api/recent') {
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
    }

    // อ่านข้อความเป็นเสียงไทย (ได้เฉพาะข้อความของโดเนทที่เกิดขึ้นจริง)
    if (m === 'GET' && pathname.startsWith('/tts/')) {
      const text = ttsText.get(pathname.slice(5));
      if (!text) { res.writeHead(404); return res.end(); }
      // Google Translate TTS (ไม่ใช่ API ทางการ — ถ้าใช้ไม่ได้ overlay จะสลับไปใช้เสียงเบราว์เซอร์เอง)
      const url = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=th&client=tw-ob&q=' + encodeURIComponent(text.slice(0, 200));
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!r || !r.ok) { res.writeHead(502); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      return res.end(Buffer.from(await r.arrayBuffer()));
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
  console.log(`SONG SOD Donate ${VERSION} running on :${PORT}  (testMode=${TEST_MODE})`);
  if (ADMIN_KEY === 'changeme') console.log('⚠️  ตั้ง ADMIN_KEY ก่อนขึ้นออนไลน์จริงนะ');
});
