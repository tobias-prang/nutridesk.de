// NutriDesk REST-API
// Express + MariaDB (mysql2) + JWT-Auth. Analyse und Ernährungsplanung systembasiert (keine KI).
// Läuft als systemd-Service auf dem VPS; die Tauri-App spricht ausschließlich mit dieser API.
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { serveCloudFile } = require('./lib/cloud-download'); // SEC-004A: sichere Datei-Auslieferung
const { validateUpload } = require('./lib/upload-guard'); // SEC-004B: Upload-Validierung (Allowlist + Magic-Bytes)
const { scanFile } = require('./lib/malware-scan'); // SEC-004B: Malware-Scan (fail-closed)

const PORT = parseInt(process.env.PORT || '8420', 10);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('JWT_SECRET fehlt in .env'); process.exit(1); }

// ---------- FinTS (Bankanbindung) ----------
// Produkt-Registrierungsnummer liegt als Datei auf dem Server (nicht im Repo).
let FINTS_PRODUCT_ID = '';
try { FINTS_PRODUCT_ID = fs.readFileSync(process.env.FINTS_PRODUCT_FILE || '/home/.produkt-register-fints', 'utf8').trim(); }
catch (e) { console.warn('FinTS-Produkt-Key nicht gefunden:', e.message); }
let PinTanClient = null;
try { PinTanClient = require('fints').PinTanClient; }
catch (e) { console.warn('fints-Bibliothek nicht geladen:', e.message); }
// SEC-001: FinTS-URL nur serverseitig aus der banks-Tabelle + SSRF-Schutz (siehe lib/).
const { buildConnectClient, buildSyncClient } = require('./lib/bank-connect');
// Bank-PIN verschlüsselt ablegen (AES-256-GCM, Schlüssel aus JWT_SECRET abgeleitet).
const BANK_KEY = crypto.createHash('sha256').update(String(JWT_SECRET) + ':bank').digest();
function encPin(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', BANK_KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decPin(stored) {
  const buf = Buffer.from(String(stored), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', BANK_KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'nutridesk',
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'nutridesk',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true, // DATE-Spalten als 'YYYY-MM-DD' Strings, keine TZ-Überraschungen
});

const app = express();
app.disable('x-powered-by');
// Hinter Apache/Cloudflare: echte Client-IP aus X-Forwarded-For (sonst ist req.ip immer 127.0.0.1)
app.set('trust proxy', 1);
const reqIp = (req) => String(req.headers['cf-connecting-ip'] || req.ip || '').slice(0, 45);
app.use(express.json({ limit: '3mb' }));
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

// CORS: Tauri-App (Origin http://tauri.localhost) und Dev-Browser; Auth per Bearer-Token, keine Cookies
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Helpers ----------
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Validierungshelfer: geben den normalisierten Wert zurück oder werfen 400
const vStr = (v, name, max, { optional = false } = {}) => {
  if (v == null || v === '') { if (optional) return null; throw bad(name + ' fehlt'); }
  if (typeof v !== 'string') throw bad(name + ' muss Text sein');
  const t = v.trim();
  if (!t && !optional) throw bad(name + ' fehlt');
  if (t.length > max) throw bad(name + ' ist zu lang (max. ' + max + ')');
  return t;
};
const vNum = (v, name, min, max, { optional = false } = {}) => {
  if (v == null || v === '') { if (optional) return null; throw bad(name + ' fehlt'); }
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  if (!isFinite(n)) throw bad(name + ' ist keine Zahl');
  if (n < min || n > max) throw bad(name + ' muss zwischen ' + min + ' und ' + max + ' liegen');
  return n;
};
const vInt = (v, name, min, max, opts) => {
  const n = vNum(v, name, min, max, opts);
  return n == null ? null : Math.round(n);
};
const vDate = (v, name, { optional = false } = {}) => {
  if (v == null || v === '') { if (optional) return null; throw bad(name + ' fehlt'); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw bad(name + ' muss YYYY-MM-DD sein');
  const d = new Date(String(v) + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== String(v)) throw bad(name + ' ist kein gültiges Datum');
  return String(v);
};
const vEnum = (v, name, allowed, { optional = false } = {}) => {
  if (v == null || v === '') { if (optional) return null; throw bad(name + ' fehlt'); }
  if (!allowed.includes(v)) throw bad(name + ' muss eins sein von: ' + allowed.join(', '));
  return v;
};
const vBool = (v) => (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
// Profilbild darf nur ein eingebettetes Bild sein (data:image), keine externe URL (Tracking/Beacon)
const vDataImage = (v) => {
  const s = vStr(v, 'Profilbild', 400000);
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) throw bad('Profilbild muss ein eingebettetes Bild sein');
  if (s.length < 200) throw bad('Das Profilbild ist ungültig oder leer');
  return s;
};
// Zu kurze/kaputte Avatare (z. B. abgeschnittene Data-URLs) beim Ausliefern als "kein Bild" behandeln,
// damit die Initiale als Fallback erscheint statt eines kaputten Bild-Symbols.
const cleanAvatar = (a) => (typeof a === 'string' && a.length >= 200 && a.startsWith('data:image/')) ? a : null;

// ---------- Ereignis-Log (Admin-Panel) ----------
// Täglich alte Einträge entsorgen, damit die Tabelle nicht unbegrenzt wächst
setInterval(() => {
  pool.execute("DELETE FROM logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)").catch(() => {});
  // Chat-Verlauf-Retention: alte Bot-Nachrichten (90 Tage) + danach leere/alte Sessions entsorgen.
  // Das Nutzer-Gedaechtnis (bot_user_memory) bleibt unangetastet, es haengt nicht am Verlauf.
  pool.execute("DELETE FROM bot_chat WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)").catch(() => {});
  pool.execute("DELETE FROM bot_sessions WHERE last_at < DATE_SUB(NOW(), INTERVAL 90 DAY)").catch(() => {});
}, 24 * 3600 * 1000).unref();
// Fire-and-forget: ein Fehler beim Loggen darf den eigentlichen Request nie stören.
function logEvent(level, event, message, opts = {}) {
  pool.execute(
    'INSERT INTO logs (level, user_id, email, event, message, ip) VALUES (?,?,?,?,?,?)',
    [level, opts.uid || null,
      opts.email ? String(opts.email).slice(0, 190) : null,
      String(event).slice(0, 60),
      message != null ? String(message).slice(0, 500) : null,
      opts.ip ? String(opts.ip).slice(0, 45) : null],
  ).catch(() => {});
}

// ---------- Auth ----------
// Simpler In-Memory-Schutz gegen Bruteforce auf /auth/*
const authHits = new Map();
// Abgelaufene Einträge regelmäßig entsorgen, sonst wächst die Map mit jeder neuen Client-IP
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authHits) if (now > v.reset) authHits.delete(k);
}, 3600000).unref();
function rateLimitAuth(req, res, next) {
  const key = reqIp(req);
  const now = Date.now();
  const entry = authHits.get(key) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 15 * 60 * 1000; }
  entry.count++;
  authHits.set(key, entry);
  if (entry.count > 20) return res.status(429).json({ error: 'Zu viele Versuche, bitte kurz warten.' });
  next();
}

// SEC-TOKEN-10: KONTO-basierte Login-Drosselung (zusaetzlich zur IP-Drosselung), damit Credential-Stuffing
// gegen EIN Konto auch bei wechselnden/gefaelschten IPs begrenzt wird. Sanftes 15-Min-Fenster, keine harte Dauersperre.
const loginFails = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of loginFails) if (now > v.reset) loginFails.delete(k); }, 3600000).unref();
function loginFailState(ident) {
  const now = Date.now();
  const e = loginFails.get(ident) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > e.reset) { e.count = 0; e.reset = now + 15 * 60 * 1000; }
  return e;
}

// Leichter Spam-Schutz pro Nutzer für teure Endpunkte (bcrypt, externe APIs, Massen-Anlegen)
const userHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of userHits) if (now > v.reset) userHits.delete(k);
}, 3600000).unref();
function rateLimitUser(bucket, max, windowMs = 60000) {
  return (req, res, next) => {
    const key = bucket + ':' + (req.uid || reqIp(req));
    const now = Date.now();
    const e = userHits.get(key) || { count: 0, reset: now + windowMs };
    if (now > e.reset) { e.count = 0; e.reset = now + windowMs; }
    e.count++;
    userHits.set(key, e);
    if (e.count > max) return res.status(429).json({ error: 'Zu viele Anfragen, bitte einen Moment warten.' });
    next();
  };
}

// Globales Netz: harte Obergrenze aller Anfragen pro IP (Schutz gegen Flooding/DoS),
// zusätzlich zu den feineren Limits weiter unten. Großzügig, damit normale Nutzung nie anschlägt.
const globalHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of globalHits) if (now > v.reset) globalHits.delete(k);
}, 3600000).unref();
function rateLimitGlobal(req, res, next) {
  const key = reqIp(req);
  const now = Date.now();
  const e = globalHits.get(key) || { count: 0, reset: now + 60000 };
  if (now > e.reset) { e.count = 0; e.reset = now + 60000; }
  e.count++;
  globalHits.set(key, e);
  if (e.count > 300) return res.status(429).json({ error: 'Zu viele Anfragen, bitte einen Moment warten.' });
  next();
}
app.use(rateLimitGlobal);

// ---------- Cloud-Speicher (Dateien pro Nutzer, streng isoliert) ----------
const CLOUD_ROOT = process.env.CLOUD_ROOT || '/home/nutridesk.de/cloud';
const CLOUD_CATS = ['garantie', 'vertrag', 'rechnung', 'versicherung', 'sonstiges'];
const userCloudDir = (uid) => path.join(CLOUD_ROOT, String(parseInt(uid, 10)));
async function ensureUserCloud(uid) { const dir = userCloudDir(uid); await fsp.mkdir(dir, { recursive: true }); return dir; }
async function cloudUsage(uid) {
  const [[r]] = await pool.execute('SELECT COALESCE(SUM(size),0) AS used FROM cloud_files WHERE user_id = ?', [uid]);
  return Number(r.used) || 0;
}
async function cloudQuota(uid) {
  const [[u]] = await pool.execute('SELECT cloud_quota FROM users WHERE id = ?', [uid]);
  return u ? Number(u.cloud_quota) : 2147483648;
}
// Disk-Pfad einer Datei: IMMER aus (vertrauenswürdiger) uid + zufälligem stored_name gebaut,
// nie aus Nutzer-Eingaben. Zusätzliche Prüfung, dass der Pfad im User-Ordner bleibt.
function safeCloudPath(uid, storedName) {
  const dir = userCloudDir(uid);
  const p = path.join(dir, path.basename(String(storedName)));
  if (path.dirname(p) !== dir) throw new HttpError(400, 'Ungültiger Pfad');
  return p;
}
const MAX_CLOUD_FILE = 250 * 1024 * 1024;
// SEC-004B: Uploads landen ZUERST in einer Quarantaene (ausserhalb des aktiven Cloud-Verzeichnisses),
// werden validiert + gescannt und erst nach bestandener Pruefung atomar ins Aktivverzeichnis verschoben.
const QUARANTINE_ROOT = process.env.QUARANTINE_ROOT || '/home/nutridesk.de/quarantine';
async function ensureQuarantine() { await fsp.mkdir(QUARANTINE_ROOT, { recursive: true }); return QUARANTINE_ROOT; }
async function reapQuarantine() {
  try {
    const entries = await fsp.readdir(QUARANTINE_ROOT).catch(() => []);
    const cutoff = Date.now() - 6 * 3600 * 1000;
    for (const e of entries) {
      const p = path.join(QUARANTINE_ROOT, e);
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.isFile() && st.mtimeMs < cutoff) await fsp.unlink(p).catch(() => {});
    }
  } catch (e) {}
}
setInterval(reapQuarantine, 60 * 60 * 1000).unref();
reapQuarantine();
const cloudUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { ensureQuarantine().then(dir => cb(null, dir)).catch(cb); },
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: MAX_CLOUD_FILE, files: 1 },
});
function uploadRejectMsg(reason) {
  const M = {
    empty: 'Die Datei ist leer.',
    ext_not_allowed: 'Dieser Dateityp ist nicht erlaubt. Zulässig sind PDF, Bilder (PNG, JPG, WEBP, GIF), TXT, CSV sowie Word/Excel/PowerPoint (docx, xlsx, pptx).',
    too_large_for_type: 'Die Datei ist für diesen Dateityp zu groß.',
    type_mismatch: 'Der Dateiinhalt passt nicht zur Dateiendung.',
    image_undecodable: 'Das Bild ist beschädigt oder nicht lesbar.',
    image_dimensions: 'Die Bildabmessungen sind zu groß.',
    image_pixels: 'Das Bild hat zu viele Bildpunkte.',
    trailing_data: 'Die Datei enthält zusätzliche Daten hinter dem eigentlichen Inhalt.',
    pdf_structure: 'Die PDF-Datei ist beschädigt.',
    pdf_encrypted: 'Verschlüsselte PDF-Dateien werden nicht angenommen.',
    pdf_active_content: 'Die PDF enthält aktive Inhalte (z. B. JavaScript oder eingebettete Dateien) und wurde abgelehnt.',
    binary_in_text: 'Die Textdatei enthält ungültige oder binäre Daten.',
    ooxml_not_zip: 'Die Office-Datei ist ungültig.',
    ooxml_corrupt: 'Die Office-Datei ist beschädigt.',
    ooxml_no_content_types: 'Die Office-Datei hat keine gültige Struktur.',
    ooxml_macro: 'Office-Dateien mit Makros werden aus Sicherheitsgründen nicht angenommen.',
    ooxml_embedded: 'Die Office-Datei enthält eingebettete Objekte und wurde abgelehnt.',
    ooxml_too_many_entries: 'Die Office-Datei ist zu komplex.',
    ooxml_too_large: 'Der entpackte Inhalt der Office-Datei ist zu groß.',
    ooxml_ratio: 'Die Office-Datei ist verdächtig stark komprimiert.',
  };
  return M[reason] || 'Die Datei wurde aus Sicherheitsgründen abgelehnt.';
}
const utf8name = (s) => { try { return Buffer.from(String(s || ''), 'latin1').toString('utf8'); } catch (e) { return String(s || ''); } };

// SEC-TOKEN-2/3: av (auth_version) fuer Widerruf; feste iss/aud + eindeutige jti + typ-Header (RFC 8725).
const signToken = (user) => jwt.sign(
  { uid: user.id, email: user.email, av: user.auth_version != null ? Number(user.auth_version) : 1, jti: crypto.randomUUID() },
  JWT_SECRET,
  { expiresIn: '45d', algorithm: 'HS256', issuer: 'nutridesk-auth', audience: 'nutridesk-api', header: { typ: 'at+jwt' } });

// Präsenz: last_seen gedrosselt aktualisieren (max. 1 Schreibvorgang/Minute pro Nutzer)
const _seenAt = new Map();
function touchLastSeen(uid) {
  const now = Date.now();
  if (now - (_seenAt.get(uid) || 0) < 60000) return;
  _seenAt.set(uid, now);
  pool.execute('UPDATE users SET last_seen = NOW() WHERE id = ?', [uid]).catch(() => {});
}
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }); } // feste Algorithmus-Allowlist (RFC 8725)
  catch { return res.status(401).json({ error: 'Sitzung abgelaufen, bitte neu anmelden' }); }
  // SEC-TOKEN-3: iss/aud pruefen, falls vorhanden. Alt-Tokens ohne diese Claims bleiben gueltig (kein Massen-Logout);
  // strikte Pflicht kommt beim Legacy-Cutoff (SEC-TOKEN-11).
  if (payload.iss && payload.iss !== 'nutridesk-auth') return res.status(401).json({ error: 'Sitzung ungültig, bitte neu anmelden' });
  if (payload.aud && payload.aud !== 'nutridesk-api') return res.status(401).json({ error: 'Sitzung ungültig, bitte neu anmelden' });
  try {
    // SEC-TOKEN-2: bei JEDEM Request frisch pruefen. Konto muss existieren und die Token-auth_version muss
    // dem aktuellen DB-Wert entsprechen. Passwortaenderung/Logout-all/Admin-Reset erhoehen auth_version -> Token sofort ungueltig.
    const [[u]] = await pool.execute('SELECT auth_version FROM users WHERE id = ?', [payload.uid]);
    if (!u) return res.status(401).json({ error: 'Sitzung ungültig, bitte neu anmelden' });
    const tokenAv = payload.av == null ? 1 : Number(payload.av); // Alt-Tokens ohne av gelten als Version 1 (bis zum ersten Bump)
    if (tokenAv !== Number(u.auth_version)) return res.status(401).json({ error: 'Sitzung wurde beendet, bitte neu anmelden' });
    req.uid = payload.uid;
    touchLastSeen(payload.uid);
    next();
  } catch (e) { next(e); }
}

// Öffentliche Registrierung im Early Access deaktiviert; Konten vergibt nur der Admin.
const REGISTRATION_OPEN = process.env.REGISTRATION_OPEN === '1';
app.post('/auth/register', rateLimitAuth, asyncRoute(async (req, res) => {
  if (!REGISTRATION_OPEN) return res.status(403).json({ error: 'Die Registrierung ist im Early Access deaktiviert. Konten werden nur vom Administrator vergeben.' });
  const email = vStr(req.body.email, 'E-Mail', 190).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('E-Mail-Adresse ist ungültig');
  const name = vStr(req.body.name, 'Name', 80);
  const password = vStr(req.body.password, 'Passwort', 200);
  if (password.length < 8) throw bad('Passwort braucht mindestens 8 Zeichen');

  // Optionaler Einladungscode (REGISTRATION_CODE in .env setzen, um Registrierung zu schützen)
  if (process.env.REGISTRATION_CODE && req.body.code !== process.env.REGISTRATION_CODE) {
    throw bad('Registrierung erfordert einen Einladungscode');
  }

  const hash = await bcrypt.hash(password, 11);
  const conn = await pool.getConnection();
  let userId;
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO users (email, pass_hash, name) VALUES (?, ?, ?)', [email, hash, name]);
    userId = result.insertId;
    await conn.execute('INSERT INTO user_settings (user_id) VALUES (?)', [userId]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') throw bad('Diese E-Mail ist schon registriert');
    throw e;
  } finally {
    conn.release();
  }
  const user = { id: userId, email, name };
  await ensureUserCloud(userId).catch(() => {});
  logEvent('info', 'register', 'Neues Konto registriert: ' + email, { uid: userId, email, ip: reqIp(req) });
  res.set('Cache-Control', 'no-store');
  res.json({ token: signToken(user), user });
}));

app.post('/auth/login', rateLimitAuth, asyncRoute(async (req, res) => {
  const raw = req.body.identifier !== undefined ? req.body.identifier : req.body.email;
  const ident = vStr(raw, 'E-Mail oder Benutzername', 190).toLowerCase().trim();
  const login = ident.charAt(0) === '@' ? ident.slice(1) : ident;
  const password = vStr(req.body.password, 'Passwort', 200);
  res.set('Cache-Control', 'no-store'); // SEC-TOKEN-10: Auth-Antworten nie cachen
  const fa = loginFailState(login);
  if (fa.count >= 10) return res.status(429).json({ error: 'Zu viele Fehlversuche für dieses Konto, bitte kurz warten.' });
  const [rows] = await pool.execute('SELECT id, email, username, name, admin, developer, pass_hash, auth_version FROM users WHERE email = ? OR username = ? LIMIT 1', [login, login]);
  const u = rows[0];
  // Auch bei unbekannter Kennung einen Hash vergleichen, damit die Antwortzeit nichts verrät
  const hashToCheck = u ? u.pass_hash : '$2a$11$C6UzMDM.H6dfI/f/IKcEeO7ZDLGzz2u1WVWXWuxHkDe0/8mCVLIQu';
  const ok = await bcrypt.compare(password, hashToCheck);
  if (!u || !ok) {
    fa.count++; loginFails.set(login, fa);
    logEvent('warning', 'login_failed', 'Fehlgeschlagene Anmeldung für ' + login, { uid: u ? u.id : null, email: login, ip: reqIp(req) });
    return res.status(401).json({ error: 'E-Mail/Benutzername oder Passwort ist falsch' });
  }
  loginFails.delete(login);
  logEvent('info', 'login', 'Anmeldung erfolgreich', { uid: u.id, email: u.email, ip: reqIp(req) });
  res.json({ token: signToken(u), user: { id: u.id, email: u.email, username: u.username, name: u.name, admin: u.admin, developer: u.developer } });
}));

// SEC-TOKEN-2: Von allen Geraeten abmelden = auth_version erhoehen -> alle bestehenden Tokens (auch dieses) werden ungueltig.
app.post('/auth/logout-all', auth, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  await pool.execute('UPDATE users SET auth_version = auth_version + 1 WHERE id = ?', [req.uid]);
  logEvent('info', 'logout_all', 'Von allen Geräten abgemeldet', { uid: req.uid, ip: reqIp(req) });
  res.json({ ok: true });
}));

// Prüft, ob der angemeldete Nutzer Admin ist
async function requireAdmin(req, res, next) {
  try {
    const [[u]] = await pool.execute('SELECT admin FROM users WHERE id = ?', [req.uid]);
    if (!u || !u.admin) return res.status(403).json({ error: 'Nur für Administratoren' });
    next();
  } catch (e) { next(e); }
}

// ---------- Admin: Nutzerverwaltung ----------
app.get('/admin/users', auth, requireAdmin, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT u.id, u.email, u.name, u.admin, u.developer, u.created_at, u.cloud_quota,
            (SELECT COALESCE(SUM(size),0) FROM cloud_files WHERE user_id = u.id) AS cloud_used,
            (SELECT COUNT(*) FROM ai_cooldown WHERE user_id = u.id AND used_at > DATE_SUB(NOW(), INTERVAL ${AI_COOLDOWN_DAYS} DAY)) AS ai_cooldowns
     FROM users u ORDER BY u.id ASC`);
  res.json(rows.map(r => ({ ...r, cloud_quota: Number(r.cloud_quota), cloud_used: Number(r.cloud_used), ai_cooldowns: Number(r.ai_cooldowns) })));
}));

app.delete('/admin/users/:id/cooldown', auth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await pool.execute('DELETE FROM ai_cooldown WHERE user_id = ?', [id]);
  logEvent('info', 'admin_cooldown', 'KI-Cooldown für Nutzer #' + id + ' zurückgesetzt', { uid: req.uid, ip: reqIp(req) });
  res.json({ ok: true });
}));

app.put('/admin/users/:id/quota', auth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const gb = vNum(req.body.quota_gb, 'Speicher (GB)', 0, 1024);
  const bytes = Math.round(gb * 1024 * 1024 * 1024);
  const [r] = await pool.execute('UPDATE users SET cloud_quota = ? WHERE id = ?', [bytes, id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  logEvent('info', 'admin_quota', 'Cloud-Speicher für Nutzer #' + id + ' auf ' + gb + ' GB gesetzt', { uid: req.uid, ip: reqIp(req) });
  res.json({ ok: true, quota: bytes });
}));

app.post('/admin/users', auth, requireAdmin, asyncRoute(async (req, res) => {
  const email = vStr(req.body.email, 'E-Mail', 190).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('E-Mail-Adresse ist ungültig');
  const name = vStr(req.body.name, 'Name', 80);
  const password = vStr(req.body.password, 'Passwort', 200);
  if (password.length < 8) throw bad('Passwort braucht mindestens 8 Zeichen');
  const isAdmin = vBool(req.body.admin);
  const hash = await bcrypt.hash(password, 11);
  const conn = await pool.getConnection();
  let id;
  try {
    await conn.beginTransaction();
    const [r] = await conn.execute('INSERT INTO users (email, pass_hash, name, admin) VALUES (?,?,?,?)', [email, hash, name, isAdmin]);
    id = r.insertId;
    await conn.execute('INSERT INTO user_settings (user_id) VALUES (?)', [id]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') throw bad('Diese E-Mail ist schon vergeben');
    throw e;
  } finally { conn.release(); }
  await ensureUserCloud(id).catch(() => {});
  logEvent('info', 'admin_user_create', 'Nutzer angelegt: ' + email + (isAdmin ? ' (Admin)' : ''), { uid: req.uid, email, ip: reqIp(req) });
  res.json({ id, email, name, admin: isAdmin });
}));

app.put('/admin/users/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = vStr(req.body.name, 'Name', 80);
  const email = vStr(req.body.email, 'E-Mail', 190).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('E-Mail-Adresse ist ungültig');
  const isAdmin = vBool(req.body.admin);
  const isDev = vBool(req.body.developer);
  if (id === req.uid && !isAdmin) throw bad('Du kannst dir den Admin-Status nicht selbst entziehen');
  try {
    const [r] = await pool.execute('UPDATE users SET name = ?, email = ?, admin = ?, developer = ? WHERE id = ?', [name, email, isAdmin, isDev, id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw bad('Diese E-Mail ist schon vergeben');
    throw e;
  }
  logEvent('info', 'admin_user_update', 'Nutzer #' + id + ' aktualisiert: ' + email + (isAdmin ? ' (Admin)' : '') + (isDev ? ' (Dev)' : ''), { uid: req.uid, email, ip: req.ip });
  res.json({ ok: true });
}));

app.put('/admin/users/:id/password', auth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const password = vStr(req.body.password, 'Passwort', 200);
  if (password.length < 8) throw bad('Passwort braucht mindestens 8 Zeichen');
  const hash = await bcrypt.hash(password, 11);
  // SEC-TOKEN-2: Admin-Reset invalidiert alle Tokens des Zielnutzers.
  const [r] = await pool.execute('UPDATE users SET pass_hash = ?, auth_version = auth_version + 1 WHERE id = ?', [hash, id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  logEvent('warning', 'admin_password', 'Passwort für Nutzer #' + id + ' zurückgesetzt (Sitzungen beendet)', { uid: req.uid, ip: reqIp(req) });
  res.json({ ok: true });
}));

app.delete('/admin/users/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.uid) throw bad('Du kannst dein eigenes Konto hier nicht löschen');
  const [[target]] = await pool.execute('SELECT email FROM users WHERE id = ?', [id]);
  const [r] = await pool.execute('DELETE FROM users WHERE id = ?', [id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  // Cloud-Ordner des Nutzers komplett entfernen (id ist geprüfte Ganzzahl)
  await fsp.rm(userCloudDir(id), { recursive: true, force: true }).catch(() => {});
  logEvent('warning', 'admin_user_delete', 'Nutzer #' + id + ' gelöscht' + (target ? ': ' + target.email : ''), { uid: req.uid, ip: reqIp(req) });
  res.json({ ok: true });
}));

// ---------- Admin: Logs ----------
app.get('/admin/logs', auth, requireAdmin, asyncRoute(async (req, res) => {
  const level = vEnum(req.query.level, 'Level', ['info', 'warning', 'error'], { optional: true });
  const from = vDate(req.query.from, 'Von-Datum', { optional: true });
  const to = vDate(req.query.to, 'Bis-Datum', { optional: true });
  const where = [];
  const params = [];
  if (level) { where.push('level = ?'); params.push(level); }
  if (from) { where.push('created_at >= ?'); params.push(from + ' 00:00:00'); }
  if (to) { where.push('created_at <= ?'); params.push(to + ' 23:59:59'); }
  const sql = 'SELECT id, created_at, level, user_id, email, event, message, ip FROM logs'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY id DESC LIMIT 500';
  const [rows] = await pool.execute(sql, params);
  res.json(rows);
}));

app.delete('/admin/logs', auth, requireAdmin, asyncRoute(async (req, res) => {
  await pool.execute('DELETE FROM logs');
  logEvent('warning', 'admin_logs_clear', 'Alle Logs geleert', { uid: req.uid, ip: req.ip });
  res.json({ ok: true });
}));

// ---------- Admin: Lebensmittel-Datenbank ----------
const foodFields = (b, partial) => {
  const f = {};
  if (b.name !== undefined || !partial) f.name = vStr(b.name, 'Name', 200);
  if (b.brand !== undefined) f.brand = vStr(b.brand, 'Marke', 140, { optional: true }) || null;
  if (b.barcode !== undefined) f.barcode = (b.barcode === '' || b.barcode === null) ? null : String(b.barcode).replace(/\D/g, '').slice(0, 32) || null;
  if (b.kcal !== undefined || !partial) f.kcal = vInt(b.kcal, 'Kalorien', 0, 900);
  if (b.carbs !== undefined || !partial) f.carbs = vNum(b.carbs, 'Kohlenhydrate', 0, 1000, { optional: true }) || 0;
  if (b.protein !== undefined || !partial) f.protein = vNum(b.protein, 'Protein', 0, 1000, { optional: true }) || 0;
  if (b.fat !== undefined || !partial) f.fat = vNum(b.fat, 'Fett', 0, 1000, { optional: true }) || 0;
  return f;
};
app.get('/admin/foods', auth, requireAdmin, asyncRoute(async (req, res) => {
  const q = vStr(req.query.q, 'Suche', 80, { optional: true }) || '';
  const [[cnt]] = await pool.execute('SELECT COUNT(*) AS n FROM foods');
  let rows = [];
  if (q) {
    const tokens = q.toLowerCase().replace(/[+\-><()~*"@]/g, ' ').split(/\s+/).filter(w => w.length >= 3).slice(0, 6);
    if (tokens.length) {
      const bool = tokens.map(w => '+' + w + '*').join(' ');
      try { [rows] = await pool.execute('SELECT id, barcode, name, brand, kcal, carbs, protein, fat, source FROM foods WHERE MATCH(name, brand) AGAINST (? IN BOOLEAN MODE) LIMIT 50', [bool]); }
      catch (e) { rows = []; }
    }
  } else {
    [rows] = await pool.execute('SELECT id, barcode, name, brand, kcal, carbs, protein, fat, source FROM foods ORDER BY id DESC LIMIT 50');
  }
  res.json({ total: Number(cnt.n), foods: rows });
}));
app.post('/admin/foods', auth, requireAdmin, asyncRoute(async (req, res) => {
  const f = foodFields(req.body || {}, false);
  f.source = 'manual';
  const keys = Object.keys(f);
  const [r] = await pool.execute(`INSERT INTO foods (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map(k => f[k]));
  logEvent('info', 'admin_food_add', 'Lebensmittel angelegt: ' + f.name, { uid: req.uid, ip: reqIp(req) });
  res.json({ id: r.insertId });
}));
app.put('/admin/foods/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const f = foodFields(req.body || {}, true);
  const keys = Object.keys(f);
  if (!keys.length) throw bad('Keine Felder');
  const [r] = await pool.execute(`UPDATE foods SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`, [...keys.map(k => f[k]), req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ ok: true });
}));
app.delete('/admin/foods/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const [r] = await pool.execute('DELETE FROM foods WHERE id = ?', [req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ ok: true });
}));

// ---------- Admin: Rezepte ----------
app.get('/admin/recipes', auth, requireAdmin, asyncRoute(async (req, res) => {
  const q = vStr(req.query.q, 'Suche', 80, { optional: true }) || '';
  let rows;
  if (q) [rows] = await pool.query('SELECT id, name, meal, kcal, protein, carbs, fat, tags, servings, time_min, source FROM recipes WHERE name LIKE ? ORDER BY id DESC LIMIT 100', ['%' + q + '%']);
  else [rows] = await pool.execute('SELECT id, name, meal, kcal, protein, carbs, fat, tags, servings, time_min, source FROM recipes ORDER BY id DESC LIMIT 100');
  const [[cnt]] = await pool.execute('SELECT COUNT(*) AS n FROM recipes');
  res.json({ total: Number(cnt.n), recipes: rows });
}));
app.get('/admin/recipes/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const [[r]] = await pool.execute('SELECT * FROM recipes WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const [ing] = await pool.execute('SELECT id, food_id, name, amount_g, kcal, carbs, protein, fat FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id ASC', [req.params.id]);
  let steps = []; try { steps = JSON.parse(r.steps || '[]') || []; } catch (e) {}
  res.json({ ...r, steps, ingredients: ing });
}));
app.post('/admin/recipes', auth, requireAdmin, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const name = vStr(b.name, 'Name', 160);
  const meal = vEnum(b.meal, 'Mahlzeit', ['fruh', 'mittag', 'abend', 'snack']);
  const servings = vInt(b.servings, 'Portionen', 1, 20, { optional: true }) || 1;
  const time_min = vInt(b.time_min, 'Zeit', 0, 600, { optional: true }) || 0;
  const tags = vStr(b.tags, 'Tags', 255, { optional: true }) || null;
  const stepsArr = Array.isArray(b.steps) ? b.steps.map(s => String(s).slice(0, 400)).filter(Boolean).slice(0, 20) : [];
  const ingIn = Array.isArray(b.ingredients) ? b.ingredients.slice(0, 40) : [];
  if (!ingIn.length) throw bad('Mindestens eine Zutat nötig');
  // Nährwerte der food-verknüpften Zutaten aus der foods-Tabelle holen
  const foodIds = [...new Set(ingIn.map(i => parseInt(i.food_id)).filter(x => x > 0))];
  const foodMap = {};
  if (foodIds.length) {
    const [frows] = await pool.query('SELECT id, name, kcal, carbs, protein, fat FROM foods WHERE id IN (?)', [foodIds]);
    for (const f of frows) foodMap[f.id] = f;
  }
  const ings = [];
  let tK = 0, tC = 0, tP = 0, tF = 0;
  for (const i of ingIn) {
    const amount = Math.max(0, Math.min(100000, parseFloat(i.amount_g) || 0));
    const fid = parseInt(i.food_id) || 0;
    let nm = vStr(i.name || (foodMap[fid] ? foodMap[fid].name : ''), 'Zutat', 160, { optional: true }) || 'Zutat';
    let k = 0, c = 0, p = 0, ft = 0;
    if (fid && foodMap[fid]) {
      const f = foodMap[fid], r = amount / 100;
      k = (f.kcal || 0) * r; c = (f.carbs || 0) * r; p = (f.protein || 0) * r; ft = (f.fat || 0) * r;
    } else {
      k = Math.max(0, parseFloat(i.kcal) || 0); c = Math.max(0, parseFloat(i.carbs) || 0); p = Math.max(0, parseFloat(i.protein) || 0); ft = Math.max(0, parseFloat(i.fat) || 0);
    }
    tK += k; tC += c; tP += p; tF += ft;
    ings.push({ food_id: fid || null, name: nm, amount_g: amount, kcal: Math.round(k), carbs: +c.toFixed(2), protein: +p.toFixed(2), fat: +ft.toFixed(2) });
  }
  const per = (x) => +(x / servings).toFixed(2);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rr] = await conn.execute(
      'INSERT INTO recipes (name, meal, servings, time_min, kcal, carbs, protein, fat, tags, steps, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [name, meal, servings, time_min, Math.round(tK / servings), per(tC), per(tP), per(tF), tags, JSON.stringify(stepsArr), 'manual']);
    for (const g of ings) {
      await conn.execute('INSERT INTO recipe_ingredients (recipe_id, food_id, name, amount_g, kcal, carbs, protein, fat) VALUES (?,?,?,?,?,?,?,?)',
        [rr.insertId, g.food_id, g.name, g.amount_g, g.kcal, g.carbs, g.protein, g.fat]);
    }
    await conn.commit();
    logEvent('info', 'admin_recipe_add', 'Rezept angelegt: ' + name, { uid: req.uid, ip: reqIp(req) });
    res.json({ id: rr.insertId, kcal: Math.round(tK / servings) });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));
app.delete('/admin/recipes/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const [r] = await pool.execute('DELETE FROM recipes WHERE id = ?', [req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ ok: true });
}));

// ---------- Profil & Einstellungen ----------
app.get('/me', auth, asyncRoute(async (req, res) => {
  const [[user]] = await pool.execute('SELECT id, email, username, name, first_name, last_name, birthday, phone, street, zip, city, country, admin, developer, created_at FROM users WHERE id = ?', [req.uid]);
  const [[settings]] = await pool.execute('SELECT * FROM user_settings WHERE user_id = ?', [req.uid]);
  const settingsSafe = settings ? { ...settings, avatar: cleanAvatar(settings.avatar) } : settings;
  res.json({ user, settings: settingsSafe });
}));

// Benutzername, Anzeigename, Vor-/Nachname
app.put('/me/profile', auth, rateLimitUser('me-profile', 40), asyncRoute(async (req, res) => {
  const b = req.body;
  const sets = [], vals = [];
  if (b.name !== undefined) { sets.push('name = ?'); vals.push(vStr(b.name, 'Anzeigename', 60)); }
  if (b.first_name !== undefined) { sets.push('first_name = ?'); vals.push(b.first_name === null || b.first_name === '' ? null : vStr(b.first_name, 'Vorname', 60)); }
  if (b.last_name !== undefined) { sets.push('last_name = ?'); vals.push(b.last_name === null || b.last_name === '' ? null : vStr(b.last_name, 'Nachname', 60)); }
  if (b.birthday !== undefined) { sets.push('birthday = ?'); vals.push(b.birthday === null || b.birthday === '' ? null : vDate(b.birthday, 'Geburtstag')); }
  if (b.phone !== undefined) { sets.push('phone = ?'); vals.push(b.phone === null || b.phone === '' ? null : vStr(b.phone, 'Telefon', 40)); }
  if (b.street !== undefined) { sets.push('street = ?'); vals.push(b.street === null || b.street === '' ? null : vStr(b.street, 'Straße', 120)); }
  if (b.zip !== undefined) { sets.push('zip = ?'); vals.push(b.zip === null || b.zip === '' ? null : vStr(b.zip, 'PLZ', 20)); }
  if (b.city !== undefined) { sets.push('city = ?'); vals.push(b.city === null || b.city === '' ? null : vStr(b.city, 'Ort', 80)); }
  if (b.country !== undefined) { sets.push('country = ?'); vals.push(b.country === null || b.country === '' ? null : vStr(b.country, 'Land', 60)); }
  if (b.username !== undefined) {
    if (b.username === null || b.username === '') { sets.push('username = ?'); vals.push(null); }
    else {
      const un = vStr(b.username, 'Benutzername', 32).toLowerCase().trim().replace(/^@/, '');
      if (!/^[a-z0-9_.]{3,32}$/.test(un)) throw bad('Benutzername: 3-32 Zeichen, nur a-z, 0-9, _ und .');
      const [[dup]] = await pool.execute('SELECT id FROM users WHERE username = ? AND id <> ?', [un, req.uid]);
      if (dup) throw bad('Dieser Benutzername ist bereits vergeben');
      sets.push('username = ?'); vals.push(un);
    }
  }
  if (!sets.length) throw bad('Keine Felder zum Aktualisieren');
  vals.push(req.uid);
  try { await pool.execute('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?', vals); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw bad('Dieser Benutzername ist bereits vergeben'); throw e; }
  const [[user]] = await pool.execute('SELECT id, email, username, name, first_name, last_name, birthday, phone, street, zip, city, country, admin, developer FROM users WHERE id = ?', [req.uid]);
  res.json({ ok: true, user });
}));

app.put('/me', auth, asyncRoute(async (req, res) => {
  const name = vStr(req.body.name, 'Name', 80);
  const email = vStr(req.body.email, 'E-Mail', 190).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('E-Mail-Adresse ist ungültig');
  try {
    await pool.execute('UPDATE users SET name = ?, email = ? WHERE id = ?', [name, email, req.uid]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw bad('Diese E-Mail ist schon registriert');
    throw e;
  }
  res.json({ ok: true });
}));

app.put('/me/password', auth, rateLimitUser('me-pw', 8, 600000), asyncRoute(async (req, res) => {
  const oldPw = vStr(req.body.old_password, 'Aktuelles Passwort', 200);
  const newPw = vStr(req.body.new_password, 'Neues Passwort', 200);
  if (newPw.length < 8) throw bad('Das neue Passwort braucht mindestens 8 Zeichen');
  const [[u]] = await pool.execute('SELECT email, pass_hash, auth_version FROM users WHERE id = ?', [req.uid]);
  if (!u || !(await bcrypt.compare(oldPw, u.pass_hash))) throw bad('Das aktuelle Passwort ist falsch');
  const hash = await bcrypt.hash(newPw, 11);
  // SEC-TOKEN-2: Passwortaenderung invalidiert ALLE bestehenden Tokens; dieses Geraet bekommt ein frisches Token zurueck.
  const newAv = Number(u.auth_version) + 1;
  await pool.execute('UPDATE users SET pass_hash = ?, auth_version = ? WHERE id = ?', [hash, newAv, req.uid]);
  logEvent('warning', 'password_changed', 'Passwort geändert (alle anderen Sitzungen beendet)', { uid: req.uid, ip: reqIp(req) });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, token: signToken({ id: req.uid, email: u.email, auth_version: newAv }) });
}));

app.put('/me/name', auth, rateLimitUser('me-name', 40), asyncRoute(async (req, res) => {
  const name = vStr(req.body.name, 'Name', 60);
  await pool.execute('UPDATE users SET name = ? WHERE id = ?', [name, req.uid]);
  logEvent('info', 'me_name', 'Anzeigename geändert', { uid: req.uid, ip: reqIp(req) });
  res.json({ ok: true, name });
}));

app.put('/me/email', auth, rateLimitUser('me-email', 8, 600000), asyncRoute(async (req, res) => {
  const email = vStr(req.body.email, 'E-Mail', 190).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Bitte eine gültige E-Mail eingeben');
  // Passwort ist optional: wer eingeloggt ist, darf die E-Mail ändern. Wenn eins mitkommt, wird es geprüft.
  if (req.body.password) {
    const pw = vStr(req.body.password, 'Passwort', 200);
    const [[u]] = await pool.execute('SELECT pass_hash FROM users WHERE id = ?', [req.uid]);
    if (!u || !(await bcrypt.compare(pw, u.pass_hash))) throw bad('Das Passwort ist falsch');
  }
  const [[dup]] = await pool.execute('SELECT id FROM users WHERE email = ? AND id <> ?', [email, req.uid]);
  if (dup) throw bad('Diese E-Mail ist bereits vergeben');
  await pool.execute('UPDATE users SET email = ? WHERE id = ?', [email, req.uid]);
  logEvent('info', 'me_email', 'E-Mail geändert auf ' + email, { uid: req.uid, ip: reqIp(req) });
  res.json({ ok: true, email });
}));

app.put('/me/settings', auth, rateLimitUser('me-set', 120), asyncRoute(async (req, res) => {
  const b = req.body;
  const fields = {
    height_cm: b.height_cm !== undefined ? vNum(b.height_cm, 'Größe', 80, 250, { optional: true }) : undefined,
    age: b.age !== undefined ? vInt(b.age, 'Alter', 10, 120, { optional: true }) : undefined,
    sex: b.sex !== undefined ? vEnum(b.sex, 'Geschlecht', ['m', 'w']) : undefined,
    activity: b.activity !== undefined ? vNum(b.activity, 'Aktivität', 1, 2.5) : undefined,
    ziel_typ: b.ziel_typ !== undefined ? vInt(b.ziel_typ, 'Ziel', -1000, 1000) : undefined,
    accent: b.accent !== undefined ? vEnum(b.accent, 'Akzent', ['lime', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'fuchsia', 'rose', 'orange', 'amber']) : undefined,
    theme: b.theme !== undefined ? vEnum(b.theme, 'Theme', ['dark', 'light']) : undefined,
    assistant: b.assistant !== undefined ? vEnum(b.assistant, 'Assistent', ['robot', 'man', 'woman']) : undefined,
    mono_digits: b.mono_digits !== undefined ? vBool(b.mono_digits) : undefined,
    compact: b.compact !== undefined ? vBool(b.compact) : undefined,
    tts_read: b.tts_read !== undefined ? vBool(b.tts_read) : undefined, // SEC-003B: lokales Vorlesen an/aus

    notif_prefs: b.notif_prefs !== undefined ? (b.notif_prefs === null || b.notif_prefs === '' ? null : vStr(b.notif_prefs, 'Benachrichtigungen', 1000)) : undefined,
    onboarded: b.onboarded !== undefined ? vBool(b.onboarded) : undefined,
    ki_answers: b.ki_answers !== undefined ? vStr(b.ki_answers, 'KI-Antworten', 4000, { optional: true }) : undefined,
    target_weight: b.target_weight !== undefined ? vNum(b.target_weight, 'Zielgewicht', 30, 300, { optional: true }) : undefined,
    avatar: b.avatar !== undefined ? (b.avatar === null || b.avatar === '' ? null : vDataImage(b.avatar)) : undefined,
    macro_c: b.macro_c !== undefined ? vInt(b.macro_c, 'KH-Anteil', 0, 100) : undefined,
    macro_p: b.macro_p !== undefined ? vInt(b.macro_p, 'Protein-Anteil', 0, 100) : undefined,
    macro_f: b.macro_f !== undefined ? vInt(b.macro_f, 'Fett-Anteil', 0, 100) : undefined,
    water_goal_ml: b.water_goal_ml !== undefined ? (b.water_goal_ml === null || b.water_goal_ml === '' ? null : vInt(b.water_goal_ml, 'Wasserziel', 250, 8000)) : undefined,
    bot_tone: b.bot_tone !== undefined ? vEnum(b.bot_tone, 'Ton', ['neutral', 'locker', 'coach']) : undefined,
    share_chats: b.share_chats !== undefined ? vBool(b.share_chats) : undefined,
    allow_location: b.allow_location !== undefined ? vBool(b.allow_location) : undefined,
    home_city: b.home_city !== undefined ? (b.home_city === null || b.home_city === '' ? null : vStr(b.home_city, 'Stadt', 80)) : undefined,
    home_lat: b.home_lat !== undefined ? (b.home_lat === null || b.home_lat === '' ? null : vNum(b.home_lat, 'Breitengrad', -90, 90)) : undefined,
    home_lon: b.home_lon !== undefined ? (b.home_lon === null || b.home_lon === '' ? null : vNum(b.home_lon, 'Längengrad', -180, 180)) : undefined,
  };
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (!keys.length) throw bad('Keine Felder zum Aktualisieren');
  const sql = 'UPDATE user_settings SET ' + keys.map(k => k + ' = ?').join(', ') + ' WHERE user_id = ?';
  await pool.execute(sql, [...keys.map(k => fields[k]), req.uid]);
  res.json({ ok: true });
}));

// ---------- Generische CRUD-Ressourcen ----------
// Jede Ressource: Tabellenname + Feld-Validierer. Alle Zeilen sind strikt user-gebunden.
const RESOURCES = {
  dishes: {
    table: 'dishes',
    parse: (b, partial) => ({
      name: b.name !== undefined || !partial ? vStr(b.name, 'Name', 120) : undefined,
      kcal: b.kcal !== undefined || !partial ? vInt(b.kcal, 'kcal', 0, 5000) : undefined,
      carbs: b.carbs !== undefined ? vInt(b.carbs, 'Kohlenhydrate', 0, 1000, { optional: true }) ?? 0 : (partial ? undefined : 0),
      protein: b.protein !== undefined ? vInt(b.protein, 'Protein', 0, 1000, { optional: true }) ?? 0 : (partial ? undefined : 0),
      fat: b.fat !== undefined ? vInt(b.fat, 'Fett', 0, 1000, { optional: true }) ?? 0 : (partial ? undefined : 0),
      time_min: b.time_min !== undefined ? vInt(b.time_min, 'Zeit', 0, 600, { optional: true }) ?? 0 : (partial ? undefined : 0),
      ingredients: b.ingredients !== undefined || !partial
        ? JSON.stringify(Array.isArray(b.ingredients) ? b.ingredients.slice(0, 40).map(x => String(x).slice(0, 120)) : [])
        : undefined,
      source: b.source !== undefined ? vEnum(b.source, 'Quelle', ['gemini', 'manual']) : (partial ? undefined : 'manual'),
    }),
  },
  shopping: {
    table: 'shopping_items',
    parse: (b, partial) => ({
      category: b.category !== undefined || !partial ? (vStr(b.category, 'Kategorie', 60, { optional: true }) || 'Sonstiges') : undefined,
      name: b.name !== undefined || !partial ? vStr(b.name, 'Name', 120) : undefined,
      qty: b.qty !== undefined || !partial ? (vNum(b.qty, 'Menge', 0, 100000, { optional: true }) ?? 1) : undefined,
      unit: b.unit !== undefined || !partial ? (vStr(b.unit, 'Einheit', 20, { optional: true }) || 'Stk') : undefined,
      price: b.price !== undefined || !partial ? (vNum(b.price, 'Preis', 0, 100000, { optional: true }) ?? 0) : undefined,
      checked: b.checked !== undefined ? vBool(b.checked) : (partial ? undefined : 0),
    }),
  },
  transactions: {
    table: 'transactions',
    parse: (b, partial) => ({
      date: b.date !== undefined || !partial ? vDate(b.date, 'Datum') : undefined,
      name: b.name !== undefined || !partial ? vStr(b.name, 'Name', 120) : undefined,
      category: b.category !== undefined || !partial ? (vStr(b.category, 'Kategorie', 60, { optional: true }) || 'Sonstiges') : undefined,
      amount: b.amount !== undefined || !partial ? vNum(b.amount, 'Betrag', -1000000, 1000000) : undefined,
      tag: b.tag !== undefined ? vStr(b.tag, 'Tag', 40, { optional: true }) : (partial ? undefined : null),
      info: b.info !== undefined ? vStr(b.info, 'Verwendungszweck', 400, { optional: true }) : (partial ? undefined : null),
      planned: b.planned !== undefined ? vBool(b.planned) : (partial ? undefined : 0),
    }),
  },
  subscriptions: {
    table: 'subscriptions',
    parse: (b, partial) => ({
      type: b.type !== undefined || !partial ? vEnum(b.type, 'Typ', ['streaming', 'musik', 'mobilfunk', 'fitness', 'cloud', 'gaming', 'news', 'versicherung', 'hosting', 'software', 'sonstiges']) : undefined,
      name: b.name !== undefined || !partial ? vStr(b.name, 'Name', 120) : undefined,
      price: b.price !== undefined || !partial ? vNum(b.price, 'Preis', 0, 100000) : undefined,
      day: b.day !== undefined || !partial ? vInt(b.day, 'Abbuchungstag', 1, 31) : undefined,
      cycle: b.cycle !== undefined || !partial ? vEnum(b.cycle, 'Turnus', ['monatlich', 'jährlich']) : undefined,
      frist: b.frist !== undefined || !partial ? vStr(b.frist, 'Kündigungsfrist', 20) : undefined,
      cancel_date: b.cancel_date !== undefined ? vDate(b.cancel_date, 'Kündigungsdatum', { optional: true }) : (partial ? undefined : null),
      resume_date: b.resume_date !== undefined ? vDate(b.resume_date, 'Reaktivierungsdatum', { optional: true }) : (partial ? undefined : null),
      start_date: b.start_date !== undefined ? vDate(b.start_date, 'Vertragsbeginn', { optional: true }) : (partial ? undefined : null),
      phases: b.phases !== undefined ? JSON.stringify((Array.isArray(b.phases) ? b.phases : []).slice(0, 12).map(p => ({ m: Math.max(1, Math.min(600, parseInt(p.m) || 1)), p: Math.max(0, Math.min(1000000, parseFloat(String(p.p).replace(',', '.')) || 0)) }))) : (partial ? undefined : '[]'),
      auto_book: b.auto_book !== undefined ? vBool(b.auto_book) : (partial ? undefined : 1),
    }),
  },
  income_sources: {
    table: 'income_sources',
    parse: (b, partial) => ({
      kind: b.kind !== undefined || !partial ? vEnum(b.kind, 'Art', ['haupt', 'neben', 'temp']) : undefined,
      name: b.name !== undefined || !partial ? vStr(b.name, 'Bezeichnung', 120) : undefined,
      amount: b.amount !== undefined || !partial ? vNum(b.amount, 'Betrag', 0, 10000000) : undefined,
      start_date: b.start_date !== undefined || !partial ? vDate(b.start_date, 'Startdatum') : undefined,
      pay_day: b.pay_day !== undefined || !partial ? vInt(b.pay_day, 'Zahltag', 1, 31) : undefined,
      end_date: b.end_date !== undefined ? vDate(b.end_date, 'Enddatum', { optional: true }) : (partial ? undefined : null),
      reason: b.reason !== undefined ? vStr(b.reason, 'Grund', 300, { optional: true }) : (partial ? undefined : null),
    }),
  },
  todos: {
    table: 'todos',
    parse: (b, partial) => ({
      text: b.text !== undefined || !partial ? vStr(b.text, 'Aufgabe', 300) : undefined,
      done: b.done !== undefined ? vBool(b.done) : (partial ? undefined : 0),
      due_date: b.due_date !== undefined ? vDate(b.due_date, 'Fälligkeit', { optional: true }) : (partial ? undefined : null),
    }),
  },
  appointments: {
    table: 'appointments',
    parse: (b, partial) => {
      let time;
      if (b.time !== undefined) {
        time = vStr(b.time, 'Uhrzeit', 5, { optional: true });
        if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad('Uhrzeit muss HH:MM sein');
      } else if (!partial) time = null;
      let remind_min;
      if (b.remind_min !== undefined) {
        remind_min = b.remind_min === null || b.remind_min === '' ? null : vInt(b.remind_min, 'Erinnerung', 0, 40320);
      } else if (!partial) remind_min = null;
      return {
        title: b.title !== undefined || !partial ? vStr(b.title, 'Titel', 120) : undefined,
        date: b.date !== undefined || !partial ? vDate(b.date, 'Datum') : undefined,
        time,
        note: b.note !== undefined ? vStr(b.note, 'Notiz', 300, { optional: true }) : (partial ? undefined : null),
        remind_min,
      };
    },
  },
  loans: {
    table: 'loans',
    parse: (b, partial) => ({
      name: b.name !== undefined || !partial ? vStr(b.name, 'Name', 120) : undefined,
      type: b.type !== undefined ? vEnum(b.type, 'Kreditart', ['sonstiges', 'finanzkredit', 'autokredit', 'immobilie', 'ratenkredit', 'privatkredit', 'studienkredit', 'dispo']) : (partial ? undefined : 'sonstiges'),
      start_date: b.start_date !== undefined ? vDate(b.start_date, 'Vertragsbeginn', { optional: true }) : (partial ? undefined : null),
      balance: b.balance !== undefined || !partial ? vNum(b.balance, 'Restschuld', 0, 99999999) : undefined,
      rate: b.rate !== undefined || !partial ? vNum(b.rate, 'Monatsrate', 0.01, 999999) : undefined,
      interest: b.interest !== undefined || !partial ? vNum(b.interest, 'Zinssatz', 0, 1) : undefined,
      paid_months: b.paid_months !== undefined ? vInt(b.paid_months, 'Gezahlte Monate', 0, 1200, { optional: true }) ?? 0 : (partial ? undefined : 0),
    }),
  },
  goals: {
    table: 'goals',
    parse: (b, partial) => ({
      icon: b.icon !== undefined || !partial ? (vStr(b.icon, 'Icon', 30, { optional: true }) || 'piggy-bank') : undefined,
      name: b.name !== undefined || !partial ? vStr(b.name, 'Name', 120) : undefined,
      saved: b.saved !== undefined ? vNum(b.saved, 'Gespart', 0, 99999999) : (partial ? undefined : 0),
      target: b.target !== undefined || !partial ? vNum(b.target, 'Zielbetrag', 1, 99999999) : undefined,
      rate: b.rate !== undefined || !partial ? vNum(b.rate, 'Monatsrate', 1, 999999) : undefined,
    }),
  },
  budgets: {
    table: 'budgets',
    parse: (b, partial) => ({
      icon: b.icon !== undefined || !partial ? (vStr(b.icon, 'Icon', 30, { optional: true }) || 'gauge') : undefined,
      category: b.category !== undefined || !partial ? vStr(b.category, 'Kategorie', 60) : undefined,
      limit_amount: b.limit_amount !== undefined || !partial ? vNum(b.limit_amount, 'Limit', 1, 1000000) : undefined,
    }),
  },
  assets: {
    table: 'assets',
    parse: (b, partial) => ({
      icon: b.icon !== undefined || !partial ? (vStr(b.icon, 'Icon', 30, { optional: true }) || 'landmark') : undefined,
      name: b.name !== undefined || !partial ? vStr(b.name, 'Name', 120) : undefined,
      value: b.value !== undefined || !partial ? vNum(b.value, 'Wert', -100000000, 100000000) : undefined,
      note: b.note !== undefined ? vStr(b.note, 'Notiz', 60, { optional: true }) : (partial ? undefined : null),
    }),
  },
  people: {
    table: 'people',
    parse: (b, partial) => {
      let birthday;
      if (b.birthday !== undefined) birthday = (b.birthday === null || b.birthday === '') ? null : vDate(b.birthday, 'Geburtstag');
      else if (!partial) birthday = null;
      let gift_year;
      if (b.gift_year !== undefined) gift_year = (b.gift_year === null || b.gift_year === '') ? null : vInt(b.gift_year, 'Geschenk-Jahr', 2000, 3000);
      else if (!partial) gift_year = null;
      return {
        name: b.name !== undefined || !partial ? vStr(b.name, 'Name', 120) : undefined,
        surname: b.surname !== undefined ? vStr(b.surname, 'Nachname', 120, { optional: true }) : (partial ? undefined : null),
        relation: b.relation !== undefined || !partial ? vEnum(b.relation, 'Beziehung', ['partner', 'kind', 'familie', 'freund', 'kollege', 'sonstiges']) : undefined,
        birthday,
        note: b.note !== undefined ? vStr(b.note, 'Notiz', 300, { optional: true }) : (partial ? undefined : null),
        gift_idea: b.gift_idea !== undefined ? vStr(b.gift_idea, 'Geschenkidee', 300, { optional: true }) : (partial ? undefined : null),
        gift_year,
      };
    },
  },
};

// Zeilen-Obergrenze pro Nutzer & Tabelle (Schutz gegen unbegrenztes Massen-Anlegen).
// transactions/shopping_items dürfen groß werden (CSV-/Bank-Import, Ernährungspläne).
const RESOURCE_CAP = { transactions: 200000, shopping_items: 30000, appointments: 10000, todos: 10000 };
const DEFAULT_CAP = 3000;
for (const [route, cfg] of Object.entries(RESOURCES)) {
  const rwLimit = rateLimitUser('rw:' + route, 120, 60000);
  app.get('/' + route, auth, asyncRoute(async (req, res) => {
    const [rows] = await pool.execute(`SELECT * FROM ${cfg.table} WHERE user_id = ? ORDER BY id DESC`, [req.uid]);
    res.json(rows);
  }));
  app.post('/' + route, auth, rwLimit, asyncRoute(async (req, res) => {
    const cap = RESOURCE_CAP[cfg.table] || DEFAULT_CAP;
    const [[cnt]] = await pool.execute(`SELECT COUNT(*) AS n FROM ${cfg.table} WHERE user_id = ?`, [req.uid]);
    if (cnt.n >= cap) throw bad('Limit erreicht: maximal ' + cap + ' Einträge in diesem Bereich.');
    const f = cfg.parse(req.body || {}, false);
    const keys = Object.keys(f).filter(k => f[k] !== undefined);
    const [r] = await pool.execute(
      `INSERT INTO ${cfg.table} (user_id, ${keys.join(', ')}) VALUES (?${', ?'.repeat(keys.length)})`,
      [req.uid, ...keys.map(k => f[k])]);
    const [[row]] = await pool.execute(`SELECT * FROM ${cfg.table} WHERE id = ?`, [r.insertId]);
    res.json(row);
  }));
  app.put('/' + route + '/:id', auth, rwLimit, asyncRoute(async (req, res) => {
    const f = cfg.parse(req.body || {}, true);
    const keys = Object.keys(f).filter(k => f[k] !== undefined);
    if (!keys.length) throw bad('Keine Felder zum Aktualisieren');
    const [r] = await pool.execute(
      `UPDATE ${cfg.table} SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ? AND user_id = ?`,
      [...keys.map(k => f[k]), req.params.id, req.uid]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Nicht gefunden' });
    const [[row]] = await pool.execute(`SELECT * FROM ${cfg.table} WHERE id = ?`, [req.params.id]);
    res.json(row);
  }));
  app.delete('/' + route + '/:id', auth, rwLimit, asyncRoute(async (req, res) => {
    const [r] = await pool.execute(`DELETE FROM ${cfg.table} WHERE id = ? AND user_id = ?`, [req.params.id, req.uid]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json({ ok: true });
  }));
}

// ---------- Kredit-Sondertilgung: reduziert die Restschuld atomar und protokolliert die Zahlung ----------
const loanPayLimit = rateLimitUser('rw:loanpay', 120, 60000);
app.get('/loans/:id/payments', auth, asyncRoute(async (req, res) => {
  const [[loan]] = await pool.execute('SELECT id FROM loans WHERE id = ? AND user_id = ?', [req.params.id, req.uid]);
  if (!loan) return res.status(404).json({ error: 'Nicht gefunden' });
  const [rows] = await pool.execute('SELECT * FROM loan_payments WHERE loan_id = ? AND user_id = ? ORDER BY id DESC LIMIT 200', [req.params.id, req.uid]);
  res.json(rows);
}));
app.post('/loans/:id/payment', auth, loanPayLimit, asyncRoute(async (req, res) => {
  const amount = vNum(req.body.amount, 'Betrag', 0.01, 99999999);
  const note = req.body.note !== undefined ? vStr(req.body.note, 'Notiz', 200, { optional: true }) : null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[loan]] = await conn.execute('SELECT * FROM loans WHERE id = ? AND user_id = ? FOR UPDATE', [req.params.id, req.uid]);
    if (!loan) { await conn.rollback(); return res.status(404).json({ error: 'Nicht gefunden' }); }
    const newBalance = Math.max(0, Math.round((Number(loan.balance) - amount) * 100) / 100);
    await conn.execute('UPDATE loans SET balance = ? WHERE id = ?', [newBalance, loan.id]);
    await conn.execute('INSERT INTO loan_payments (user_id, loan_id, amount, note) VALUES (?, ?, ?, ?)', [req.uid, loan.id, amount, note]);
    await conn.commit();
    const [[row]] = await pool.execute('SELECT * FROM loans WHERE id = ?', [loan.id]);
    res.json({ loan: row });
  } catch (e) { try { await conn.rollback(); } catch (_) {} throw e; } finally { conn.release(); }
}));

// ---------- Notgroschen: einfacher Sparstand mit Ein-/Auszahlungen + Verlauf ----------
const emergencyLimit = rateLimitUser('rw:emergency', 120, 60000);
app.get('/emergency', auth, asyncRoute(async (req, res) => {
  const [[s]] = await pool.execute('SELECT emergency_fund FROM user_settings WHERE user_id = ?', [req.uid]);
  const [log] = await pool.execute('SELECT * FROM emergency_log WHERE user_id = ? ORDER BY id DESC LIMIT 200', [req.uid]);
  res.json({ total: Number((s && s.emergency_fund) || 0), log });
}));
app.post('/emergency', auth, emergencyLimit, asyncRoute(async (req, res) => {
  const amount = vNum(req.body.amount, 'Betrag', 0.01, 99999999);
  const kind = vEnum(req.body.kind, 'Art', ['deposit', 'withdraw']);
  const note = req.body.note !== undefined ? vStr(req.body.note, 'Notiz', 200, { optional: true }) : null;
  const delta = kind === 'withdraw' ? -amount : amount;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('INSERT IGNORE INTO user_settings (user_id) VALUES (?)', [req.uid]);
    const [[s]] = await conn.execute('SELECT emergency_fund FROM user_settings WHERE user_id = ? FOR UPDATE', [req.uid]);
    const cur = Number((s && s.emergency_fund) || 0);
    const next = Math.round((cur + delta) * 100) / 100;
    if (next < 0) { await conn.rollback(); return res.status(400).json({ error: 'So viel ist nicht im Notgroschen.' }); }
    await conn.execute('UPDATE user_settings SET emergency_fund = ? WHERE user_id = ?', [next, req.uid]);
    await conn.execute('INSERT INTO emergency_log (user_id, delta, note) VALUES (?, ?, ?)', [req.uid, delta, note]);
    await conn.commit();
    const [[entry]] = await pool.execute('SELECT * FROM emergency_log WHERE user_id = ? ORDER BY id DESC LIMIT 1', [req.uid]);
    res.json({ total: next, entry });
  } catch (e) { try { await conn.rollback(); } catch (_) {} throw e; } finally { conn.release(); }
}));

// ---------- Spiele: XP / Nutris / Level + rotierende Tagesquest ----------
const GAME_XP_CAP = 500;
const QUESTS = [
  { id: 'quiz_win', title: 'Quiz-Champion', desc: 'Beende ein Quiz mit mindestens 4 richtigen Antworten.', target: 4, reward: 60, kind: 'quiz_correct' },
  { id: 'arcade_score', title: 'Frucht-Jäger', desc: 'Erreiche 60 Punkte in Fruit Rush.', target: 60, reward: 60, kind: 'arcade_score' },
  { id: 'play_any', title: 'Warmspielen', desc: 'Spiele heute 3 Runden, egal welches Spiel.', target: 3, reward: 50, kind: 'rounds' },
  { id: 'quiz_food', title: 'Ernährungs-Profi', desc: 'Beantworte 6 Lebensmittel-Fragen richtig.', target: 6, reward: 70, kind: 'food_correct' },
];
function gLevel(xp) { let l = 1; while (100 * l * (l + 1) <= xp) l++; return l; }
function gXpForLevel(l) { return 100 * l * (l - 1); }
function gToday() { return new Date().toISOString().slice(0, 10); }
function gQuest() { return QUESTS[Math.floor(Date.now() / 86400000) % QUESTS.length]; }
async function gEnsure(uid) {
  await pool.execute('INSERT IGNORE INTO user_settings (user_id) VALUES (?)', [uid]);
  const today = gToday(), q = gQuest();
  const [[s]] = await pool.execute('SELECT xp, nutris, xp_today, xp_today_date, quest_date, quest_prog, quest_claimed FROM user_settings WHERE user_id=?', [uid]);
  let xpToday = s.xp_today, prog = s.quest_prog, claimed = s.quest_claimed;
  const xpDay = s.xp_today_date ? String(s.xp_today_date).slice(0, 10) : null;
  const qDay = s.quest_date ? String(s.quest_date).slice(0, 10) : null;
  if (xpDay !== today) { xpToday = 0; await pool.execute('UPDATE user_settings SET xp_today=0, xp_today_date=? WHERE user_id=?', [today, uid]); }
  if (qDay !== today) { prog = 0; claimed = 0; await pool.execute('UPDATE user_settings SET quest_date=?, quest_prog=0, quest_claimed=0 WHERE user_id=?', [today, uid]); }
  return { xp: s.xp, nutris: s.nutris, xpToday, prog, claimed, quest: q };
}
function gStateObj(g) {
  const level = gLevel(g.xp), base = gXpForLevel(level), next = gXpForLevel(level + 1);
  return {
    xp: g.xp, nutris: g.nutris, level, levelXp: g.xp - base, levelNeed: next - base,
    xpToday: g.xpToday, xpCap: GAME_XP_CAP,
    quest: { id: g.quest.id, title: g.quest.title, desc: g.quest.desc, target: g.quest.target, reward: g.quest.reward, prog: Math.min(g.prog, g.quest.target), done: g.prog >= g.quest.target, claimed: !!g.claimed },
  };
}
app.get('/games/state', auth, asyncRoute(async (req, res) => { res.json(gStateObj(await gEnsure(req.uid))); }));
app.post('/games/reward', auth, rateLimitUser('game-reward', 120, 60000), asyncRoute(async (req, res) => {
  const game = vEnum(req.body.game, 'Spiel', ['quiz', 'arcade']);
  const correct = vInt(req.body.correct, 'Richtige', 0, 100, { optional: true }) || 0;
  const score = vInt(req.body.score, 'Punkte', 0, 100000, { optional: true }) || 0;
  const category = vStr(req.body.category, 'Kategorie', 20, { optional: true }) || '';
  const g = await gEnsure(req.uid);
  let xpEarn = game === 'quiz' ? correct * 12 : Math.floor(score / 2);
  let nutEarn = game === 'quiz' ? correct * 4 : Math.floor(score / 4);
  const room = Math.max(0, GAME_XP_CAP - g.xpToday);
  const capped = xpEarn > room;
  xpEarn = Math.min(xpEarn, room);
  const q = g.quest; let prog = g.prog;
  if (q.kind === 'quiz_correct' && game === 'quiz') prog += correct;
  else if (q.kind === 'food_correct' && game === 'quiz' && category === 'food') prog += correct;
  else if (q.kind === 'arcade_score' && game === 'arcade') prog = Math.max(prog, score);
  else if (q.kind === 'rounds') prog += 1;
  const newXp = g.xp + xpEarn, newNut = g.nutris + nutEarn, newToday = g.xpToday + xpEarn;
  await pool.execute('UPDATE user_settings SET xp=?, nutris=?, xp_today=?, xp_today_date=?, quest_prog=?, quest_date=? WHERE user_id=?',
    [newXp, newNut, newToday, gToday(), prog, gToday(), req.uid]);
  res.json({ earned: { xp: xpEarn, nutris: nutEarn }, capped, state: gStateObj({ xp: newXp, nutris: newNut, xpToday: newToday, prog, claimed: g.claimed, quest: q }) });
}));
app.post('/games/quest/claim', auth, asyncRoute(async (req, res) => {
  const g = await gEnsure(req.uid);
  if (g.prog < g.quest.target) return res.status(400).json({ error: 'Quest noch nicht erfüllt.' });
  if (g.claimed) return res.status(400).json({ error: 'Belohnung schon abgeholt.' });
  const newNut = g.nutris + g.quest.reward;
  await pool.execute('UPDATE user_settings SET nutris=?, quest_claimed=1, quest_date=? WHERE user_id=?', [newNut, gToday(), req.uid]);
  res.json({ reward: g.quest.reward, state: gStateObj({ ...g, nutris: newNut, claimed: 1 }) });
}));
// Tages-Aktivitätsbonus: einmal pro Tag XP + Nutris fürs App-Nutzen.
app.post('/games/daily-login', auth, asyncRoute(async (req, res) => {
  const g = await gEnsure(req.uid);
  const today = gToday();
  const [[s]] = await pool.execute('SELECT login_date FROM user_settings WHERE user_id=?', [req.uid]);
  const last = s && s.login_date ? String(s.login_date).slice(0, 10) : null;
  if (last === today) return res.json({ granted: false, state: gStateObj(g) });
  const nutEarn = 10, room = Math.max(0, GAME_XP_CAP - g.xpToday), xp = Math.min(20, room);
  await pool.execute('UPDATE user_settings SET login_date=?, xp=xp+?, nutris=nutris+?, xp_today=xp_today+?, xp_today_date=? WHERE user_id=?', [today, xp, nutEarn, xp, today, req.uid]);
  res.json({ granted: true, earned: { xp, nutris: nutEarn }, state: gStateObj({ ...g, xp: g.xp + xp, nutris: g.nutris + nutEarn, xpToday: g.xpToday + xp }) });
}));

// ---------- Finanzbuch: nicht gebuchte Transaktionen (CSV-/Bank-Import) ----------
// Der Client parst die CSV lokal (Datenschutz) und schickt normalisierte Zeilen als EINEN Bulk-Request.
const STAGING_CAP = 5000;
// Gemeinsame Dedup-+-Bulk-Insert-Logik für CSV und Bank (dedup gegen gestagte UND gebuchte Umsätze).
async function stageRows(uid, rows, source) {
  const [[cnt]] = await pool.execute('SELECT COUNT(*) AS n FROM staging_transactions WHERE user_id = ?', [uid]);
  let room = STAGING_CAP - cnt.n;
  if (room <= 0) throw bad('Zu viele nicht gebuchte Transaktionen, bitte erst übernehmen oder aufräumen.');
  const seen = new Set();
  const [stg] = await pool.execute('SELECT dedup_key FROM staging_transactions WHERE user_id = ? AND dedup_key IS NOT NULL', [uid]);
  for (const r of stg) seen.add(r.dedup_key);
  const [tx] = await pool.execute("SELECT CONCAT(`date`,'|',FORMAT(amount,2),'|',LEFT(name,40)) AS k FROM transactions WHERE user_id = ? AND `date` >= DATE_SUB(CURDATE(), INTERVAL 800 DAY)", [uid]);
  for (const r of tx) seen.add(r.k);
  const vals = [];
  let skipped = 0;
  for (const r of rows) {
    if (room <= 0) { skipped++; continue; }
    let date, amount, name;
    try {
      date = vDate(r.date, 'Datum');
      amount = vNum(r.amount, 'Betrag', -10000000, 10000000);
      name = vStr(r.name || 'Umsatz', 'Name', 200);
    } catch (e) { skipped++; continue; }
    const info = (r.info != null && r.info !== '') ? String(r.info).slice(0, 400) : null;
    const category = r.category ? String(r.category).slice(0, 60) : null;
    const key = date + '|' + (Math.round(amount * 100) / 100).toFixed(2) + '|' + name.slice(0, 40);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    vals.push([uid, date, name, category, amount, info, source, key.slice(0, 120)]);
    room--;
  }
  if (vals.length) {
    await pool.query('INSERT INTO staging_transactions (user_id, `date`, name, category, amount, info, source, dedup_key) VALUES ?', [vals]);
  }
  return { added: vals.length, skipped };
}
app.post('/staging/import', auth, rateLimitUser('staging-import', 12, 60000), asyncRoute(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) throw bad('Keine Zeilen zum Importieren');
  if (rows.length > 5000) throw bad('Zu viele Zeilen auf einmal (max. 5000)');
  const source = (vStr(req.body.source, 'Quelle', 20, { optional: true }) || 'csv');
  res.json(await stageRows(req.uid, rows, source));
}));

app.get('/staging', auth, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM staging_transactions WHERE user_id = ? ORDER BY `date` DESC, id DESC', [req.uid]);
  res.json(rows);
}));

app.post('/staging/book', auth, rateLimitUser('staging-book', 30, 60000), asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) throw bad('Keine Auswahl');
  if (ids.length > 5000) throw bad('Zu viele auf einmal');
  const ph = ids.map(() => '?').join(',');
  const [rows] = await pool.execute(`SELECT * FROM staging_transactions WHERE user_id = ? AND id IN (${ph})`, [req.uid, ...ids]);
  if (!rows.length) return res.json({ booked: 0 });
  const [[cnt]] = await pool.execute('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [req.uid]);
  if (cnt.n + rows.length > 200000) throw bad('Transaktions-Limit erreicht.');
  const vals = rows.map(r => [req.uid, r.date, r.name, r.category || (parseFloat(r.amount) >= 0 ? 'Einzahlung' : 'Sonstiges'), r.amount, r.info || null, 'Bank', 0]);
  await pool.query('INSERT INTO transactions (user_id, `date`, name, category, amount, info, tag, planned) VALUES ?', [vals]);
  await pool.execute(`DELETE FROM staging_transactions WHERE user_id = ? AND id IN (${ph})`, [req.uid, ...ids]);
  res.json({ booked: rows.length });
}));

app.delete('/staging/:id', auth, rateLimitUser('staging-del', 200), asyncRoute(async (req, res) => {
  const [r] = await pool.execute('DELETE FROM staging_transactions WHERE id = ? AND user_id = ?', [req.params.id, req.uid]);
  res.json({ ok: true, deleted: r.affectedRows });
}));

app.post('/staging/clear', auth, rateLimitUser('staging-del', 200), asyncRoute(async (req, res) => {
  const [r] = await pool.execute('DELETE FROM staging_transactions WHERE user_id = ?', [req.uid]);
  res.json({ ok: true, deleted: r.affectedRows });
}));

// ---------- FinTS-Bankanbindung (Umsätze abrufen -> Staging) ----------
// Wandelt FinTS-Statements defensiv in einheitliche Zeilen {date, amount, name, info} um.
async function fetchBankRows(client, days) {
  const accounts = await client.accounts();
  const to = new Date();
  const from = new Date(); from.setDate(from.getDate() - Math.max(1, Math.min(days || 90, 3650)));
  const rows = [];
  for (const acc of (accounts || [])) {
    let statements = [];
    try { statements = await client.statements(acc, from, to); } catch (e) { continue; }
    for (const st of (statements || [])) {
      for (const t of (st.transactions || [])) {
        const amtRaw = Number(t.amount);
        if (!isFinite(amtRaw)) continue;
        const isCredit = (t.isCredit !== undefined) ? !!t.isCredit : ((t.isExpense !== undefined) ? !t.isExpense : (amtRaw >= 0));
        const amount = isCredit ? Math.abs(amtRaw) : -Math.abs(amtRaw);
        const dt = t.valueDate || t.entryDate || t.date || st.date;
        let date = '';
        if (dt instanceof Date) date = dt.toISOString().slice(0, 10);
        else if (typeof dt === 'string') date = dt.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const ds = t.descriptionStructured || {};
        let name = ds.name || t.name || t.description || 'Umsatz';
        let info = ds.reference || t.reference || (ds.name ? t.description : '') || '';
        name = String(name).replace(/\s+/g, ' ').trim().slice(0, 200) || 'Umsatz';
        info = String(info).replace(/\s+/g, ' ').trim().slice(0, 400);
        rows.push({ date, amount, name, info });
      }
    }
  }
  return rows;
}

app.get('/bank', auth, asyncRoute(async (req, res) => {
  const [[c]] = await pool.execute('SELECT blz, login, bank_name, account_iban, last_sync FROM bank_connections WHERE user_id = ?', [req.uid]);
  res.json({ connected: !!c, available: !!PinTanClient, bank: c ? { blz: c.blz, login: c.login, bank_name: c.bank_name, account_iban: c.account_iban, last_sync: c.last_sync } : null });
}));

// Bank-Suche: Nutzer findet seine Bank per Name oder BLZ, ohne die FinTS-URL zu kennen.
// Antwort bewusst OHNE fints_url, die bleibt serverseitig.
app.get('/bank/search', auth, rateLimitUser('bank-search', 60), asyncRoute(async (req, res) => {
  const q = vStr(req.query.q, 'Suchbegriff', 80, { optional: true });
  if (!q || q.length < 2) return res.json([]);
  const digits = q.replace(/\s/g, '');
  let rows;
  if (/^\d{2,}$/.test(digits)) {
    // Sieht aus wie eine Bankleitzahl: nach BLZ-Präfix suchen
    [rows] = await pool.execute(
      'SELECT blz, name, bic, city FROM banks WHERE blz LIKE ? ORDER BY CHAR_LENGTH(name), name LIMIT 10',
      [digits + '%']);
  } else {
    // Nach Name suchen, Treffer die mit dem Begriff beginnen und kurze Namen zuerst
    [rows] = await pool.execute(
      'SELECT blz, name, bic, city FROM banks WHERE name LIKE ? ORDER BY (name LIKE ?) DESC, CHAR_LENGTH(name), name LIMIT 10',
      ['%' + q + '%', q + '%']);
  }
  res.json(rows);
}));

app.post('/bank/connect', auth, rateLimitUser('bank-connect', 6, 600000), asyncRoute(async (req, res) => {
  if (!PinTanClient) throw bad('Bankanbindung ist auf dem Server nicht verfügbar.');
  const blz = vStr(req.body.blz, 'Bankleitzahl', 20).replace(/\s/g, '');
  const login = vStr(req.body.login, 'Anmeldename', 120);
  const pin = vStr(req.body.pin, 'PIN', 100);
  // SEC-001: FinTS-URL AUSSCHLIESSLICH aus der banks-Tabelle (kein Client-Override), voll validiert
  // (https, kein userinfo, Portsperre, kein internes/nicht-global-routbares Ziel, DNS-geprüft).
  // Bei ungültiger/fehlender Adresse wird der FinTS-Client nie gebaut.
  const makeClient = (o) => new PinTanClient(Object.assign({}, o, { productId: FINTS_PRODUCT_ID || undefined }));
  let built;
  try { built = await buildConnectClient({ pool, makeClient, blz, login, pin }); }
  catch (e) {
    if (e && e.code === 'no_bank_url') throw bad('Zu dieser Bank ist keine FinTS-Adresse hinterlegt, bitte Support kontaktieren.');
    throw bad('Die FinTS-Adresse dieser Bank ist ungültig, bitte Support kontaktieren.');
  }
  const url = built.url;
  const client = built.client;
  let accounts;
  try { accounts = await client.accounts(); }
  catch (e) { throw bad('Verbindung fehlgeschlagen: ' + (e && e.message ? String(e.message).slice(0, 200) : 'unbekannter Fehler') + '. Prüfe BLZ, URL, Anmeldename und PIN.'); }
  const first = (accounts && accounts[0]) || {};
  const iban = first.iban || first.accountNumber || null;
  const bankName = first.bankName || first.name || null;
  await pool.execute(
    'INSERT INTO bank_connections (user_id, blz, fints_url, login, pin_enc, bank_name, account_iban) VALUES (?,?,?,?,?,?,?) ' +
    'ON DUPLICATE KEY UPDATE blz=VALUES(blz), fints_url=VALUES(fints_url), login=VALUES(login), pin_enc=VALUES(pin_enc), bank_name=VALUES(bank_name), account_iban=VALUES(account_iban)',
    [req.uid, blz, url, login, encPin(pin), bankName, iban ? String(iban).slice(0, 40) : null]);
  logEvent('info', 'bank_connect', 'Bankkonto verknüpft (' + blz + ')', { uid: req.uid, ip: reqIp(req) });
  res.json({ ok: true, accountCount: (accounts || []).length });
}));

app.post('/bank/sync', auth, rateLimitUser('bank-sync', 12, 600000), asyncRoute(async (req, res) => {
  if (!PinTanClient) throw bad('Bankanbindung ist auf dem Server nicht verfügbar.');
  const days = vInt(req.body.days, 'Zeitraum', 1, 3650, { optional: true }) || 90;
  const [[c]] = await pool.execute('SELECT * FROM bank_connections WHERE user_id = ?', [req.uid]);
  if (!c) throw bad('Keine Bankverbindung. Bitte zuerst in den Kontoeinstellungen verknüpfen.');
  let pin;
  try { pin = decPin(c.pin_enc); } catch (e) { throw bad('Gespeicherte Zugangsdaten sind unlesbar, bitte neu verknüpfen.'); }
  // SEC-001: gespeicherte Adresse vor JEDER Nutzung voll neu validieren (Host kann inzwischen
  // privat/intern auflösen). Gleiche Validierung wie beim Connect; sonst wird der Client nie gebaut.
  const makeClient = (o) => new PinTanClient(Object.assign({}, o, { productId: FINTS_PRODUCT_ID || undefined }));
  let built;
  try { built = await buildSyncClient({ makeClient, storedUrl: c.fints_url, blz: c.blz, login: c.login, pin }); }
  catch (e) { throw bad('Die gespeicherte Bank-Adresse ist ungültig, bitte neu verknüpfen.'); }
  const client = built.client;
  let rows;
  try { rows = await fetchBankRows(client, days); }
  catch (e) { throw bad('Bank-Abruf fehlgeschlagen: ' + (e && e.message ? String(e.message).slice(0, 200) : 'evtl. wird eine TAN benötigt.')); }
  const result = await stageRows(req.uid, rows, 'bank');
  await pool.execute('UPDATE bank_connections SET last_sync = NOW() WHERE user_id = ?', [req.uid]);
  res.json({ ok: true, fetched: rows.length, added: result.added, skipped: result.skipped });
}));

app.delete('/bank', auth, asyncRoute(async (req, res) => {
  await pool.execute('DELETE FROM bank_connections WHERE user_id = ?', [req.uid]);
  res.json({ ok: true });
}));

// ---------- Spezielle Ressourcen ----------
// Gewicht: ein Eintrag pro Tag (upsert)
app.post('/weights', auth, rateLimitUser('weights', 120), asyncRoute(async (req, res) => {
  const date = vDate(req.body.date, 'Datum');
  const kg = vNum(req.body.kg, 'Gewicht', 30, 300);
  await pool.execute(
    'INSERT INTO weights (user_id, `date`, kg) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE kg = VALUES(kg)',
    [req.uid, date, kg]);
  res.json({ ok: true, date, kg });
}));
app.get('/weights', auth, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT id, `date`, kg FROM weights WHERE user_id = ? ORDER BY `date` ASC', [req.uid]);
  res.json(rows);
}));

// Wasser: Gläser pro Tag (upsert)
app.put('/water/:date', auth, rateLimitUser('water', 120), asyncRoute(async (req, res) => {
  const date = vDate(req.params.date, 'Datum');
  const glasses = vInt(req.body.glasses, 'Gläser', 0, 24);
  await pool.execute(
    'INSERT INTO water_log (user_id, `date`, glasses) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE glasses = VALUES(glasses)',
    [req.uid, date, glasses]);
  res.json({ ok: true, date, glasses });
}));

// Food-Log (Tracker)
app.post('/food-log', auth, rateLimitUser('foodlog', 180), asyncRoute(async (req, res) => {
  const b = req.body;
  const f = {
    date: vDate(b.date, 'Datum'),
    meal: vEnum(b.meal, 'Mahlzeit', ['fruh', 'mittag', 'abend', 'snack']),
    name: vStr(b.name, 'Name', 120),
    kcal: vInt(b.kcal, 'kcal', 0, 5000),
    carbs: vInt(b.carbs, 'Kohlenhydrate', 0, 1000, { optional: true }),
    protein: vInt(b.protein, 'Protein', 0, 1000, { optional: true }),
    fat: vInt(b.fat, 'Fett', 0, 1000, { optional: true }),
    dish_id: b.dish_id != null ? vInt(b.dish_id, 'Gericht', 1, 4294967295, { optional: true }) : null,
  };
  if (f.dish_id) {
    const [[dish]] = await pool.execute('SELECT id FROM dishes WHERE id = ? AND user_id = ?', [f.dish_id, req.uid]);
    if (!dish) f.dish_id = null;
  }
  const [r] = await pool.execute(
    'INSERT INTO food_log (user_id, `date`, meal, name, kcal, carbs, protein, fat, dish_id) VALUES (?,?,?,?,?,?,?,?,?)',
    [req.uid, f.date, f.meal, f.name, f.kcal, f.carbs, f.protein, f.fat, f.dish_id]);
  const [[row]] = await pool.execute('SELECT * FROM food_log WHERE id = ?', [r.insertId]);
  res.json(row);
}));
app.delete('/food-log/:id', auth, rateLimitUser('foodlog', 180), asyncRoute(async (req, res) => {
  const [r] = await pool.execute('DELETE FROM food_log WHERE id = ? AND user_id = ?', [req.params.id, req.uid]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ ok: true });
}));

// ---------- Gerichte-Bewertungen (Daumen hoch/runter) ----------
// Am Namen festgemacht, damit Bewertungen das Aufräumen alter KI-Gerichte überleben.
app.post('/dish-ratings', auth, asyncRoute(async (req, res) => {
  const name = vStr(req.body.name, 'Gericht', 120);
  const liked = vBool(req.body.liked);
  await pool.execute(
    'INSERT INTO dish_ratings (user_id, name, liked) VALUES (?,?,?) ON DUPLICATE KEY UPDATE liked = VALUES(liked)',
    [req.uid, name, liked]);
  res.json({ ok: true, name, liked });
}));
app.delete('/dish-ratings', auth, asyncRoute(async (req, res) => {
  const name = vStr(req.body.name, 'Gericht', 120);
  await pool.execute('DELETE FROM dish_ratings WHERE user_id = ? AND name = ?', [req.uid, name]);
  res.json({ ok: true });
}));

// ---------- Tresor: Notizen (optional pro Notiz passwortgeschützt) ----------
// Liste liefert Inhalte NUR für ungeschützte Notizen; geschützte brauchen /unlock.
app.get('/notes', auth, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT id, title, content, pass_hash, created_at, updated_at FROM notes WHERE user_id = ? ORDER BY updated_at DESC', [req.uid]);
  res.json(rows.map(n => ({
    id: n.id, title: n.title, locked: !!n.pass_hash,
    content: n.pass_hash ? null : n.content,
    created_at: n.created_at, updated_at: n.updated_at,
  })));
}));
app.post('/notes', auth, rateLimitUser('notes-write', 20), asyncRoute(async (req, res) => {
  const title = vStr(req.body.title, 'Titel', 120);
  const content = vStr(req.body.content, 'Inhalt', 60000, { optional: true }) || '';
  const password = vStr(req.body.password, 'Passwort', 200, { optional: true });
  if (password && password.length < 4) throw bad('Das Notiz-Passwort braucht mindestens 4 Zeichen');
  const hash = password ? await bcrypt.hash(password, 10) : null;
  const [r] = await pool.execute(
    'INSERT INTO notes (user_id, title, content, pass_hash) VALUES (?,?,?,?)', [req.uid, title, content, hash]);
  res.json({ id: r.insertId, title, locked: !!hash });
}));
// Geschützte Notiz entsperren (Bruteforce-Schutz wie beim Login)
app.post('/notes/:id/unlock', auth, rateLimitAuth, asyncRoute(async (req, res) => {
  const password = vStr(req.body.password, 'Passwort', 200);
  const [[n]] = await pool.execute('SELECT content, pass_hash FROM notes WHERE id = ? AND user_id = ?', [req.params.id, req.uid]);
  if (!n) return res.status(404).json({ error: 'Notiz nicht gefunden' });
  if (!n.pass_hash) return res.json({ content: n.content || '' });
  const ok = await bcrypt.compare(password, n.pass_hash);
  // 403 statt 401: der Client behandelt 401 als abgelaufene Sitzung (Auto-Logout)
  if (!ok) return res.status(403).json({ error: 'Falsches Passwort' });
  res.json({ content: n.content || '' });
}));
// Bearbeiten: geschützte Notizen verlangen das aktuelle Passwort
async function requireNote(req) {
  const [[n]] = await pool.execute('SELECT id, pass_hash FROM notes WHERE id = ? AND user_id = ?', [req.params.id, req.uid]);
  if (!n) throw new HttpError(404, 'Notiz nicht gefunden');
  if (n.pass_hash) {
    const pw = vStr(req.body.password, 'Passwort', 200, { optional: true });
    // 403 statt 401 (401 = Auto-Logout im Client)
    if (!pw || !(await bcrypt.compare(pw, n.pass_hash))) throw new HttpError(403, 'Falsches Passwort');
  }
  return n;
}
app.put('/notes/:id', auth, rateLimitUser('notes-write', 30), asyncRoute(async (req, res) => {
  await requireNote(req);
  const title = vStr(req.body.title, 'Titel', 120);
  const content = vStr(req.body.content, 'Inhalt', 60000, { optional: true }) || '';
  const sets = ['title = ?', 'content = ?'];
  const params = [title, content];
  if (req.body.remove_password) {
    sets.push('pass_hash = NULL');
  } else if (req.body.new_password) {
    const np = vStr(req.body.new_password, 'Neues Passwort', 200);
    if (np.length < 4) throw bad('Das Notiz-Passwort braucht mindestens 4 Zeichen');
    sets.push('pass_hash = ?');
    params.push(await bcrypt.hash(np, 10));
  }
  await pool.execute(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, [...params, req.params.id, req.uid]);
  res.json({ ok: true });
}));
app.delete('/notes/:id', auth, asyncRoute(async (req, res) => {
  await requireNote(req);
  await pool.execute('DELETE FROM notes WHERE id = ? AND user_id = ?', [req.params.id, req.uid]);
  res.json({ ok: true });
}));

// ---------- Community: Gamification (XP/Level/Badges, aus vorhandenen Aktivitäten abgeleitet) ----------
const XP_W = { fl: 5, w: 8, td: 4, ap: 3, pe: 3, pl: 2, tx: 1, gl: 6, nt: 3 };
function xpFromCounts(c) {
  return (c.fl || 0) * XP_W.fl + (c.w || 0) * XP_W.w + (c.td || 0) * XP_W.td + (c.ap || 0) * XP_W.ap
    + (c.pe || 0) * XP_W.pe + (c.pl || 0) * XP_W.pl + (c.tx || 0) * XP_W.tx + (c.gl || 0) * XP_W.gl + (c.nt || 0) * XP_W.nt;
}
function levelInfo(xp) {
  const level = Math.floor(Math.sqrt(xp / 100)) + 1;
  const curBase = 100 * (level - 1) * (level - 1);
  const nextBase = 100 * level * level;
  return { level, xp, inLevel: xp - curBase, span: nextBase - curBase, toNext: nextBase - xp, pct: Math.round((xp - curBase) / (nextBase - curBase) * 100) };
}
const BADGES = [
  { key: 'starter', name: 'Erste Schritte', icon: 'footprints', desc: 'Erste Mahlzeit getrackt', test: c => c.fl >= 1 },
  { key: 'tracker', name: 'Tracker', icon: 'notebook-pen', desc: '50 Mahlzeiten getrackt', test: c => c.fl >= 50 },
  { key: 'nutripro', name: 'Ernährungsprofi', icon: 'salad', desc: '200 Mahlzeiten getrackt', test: c => c.fl >= 200 },
  { key: 'weigher', name: 'Auf Kurs', icon: 'scale', desc: '10-mal Gewicht eingetragen', test: c => c.w >= 10 },
  { key: 'planner', name: 'Geplant', icon: 'calendar-check', desc: 'Einen KI-Plan erstellt', test: c => c.pl >= 1 },
  { key: 'organizer', name: 'Organisiert', icon: 'list-checks', desc: '20 To-dos erledigt', test: c => c.td >= 20 },
  { key: 'saver', name: 'Sparfuchs', icon: 'piggy-bank', desc: 'Ein Sparziel angelegt', test: c => c.gl >= 1 },
  { key: 'social', name: 'Vernetzt', icon: 'users-round', desc: '3 Menschen hinterlegt', test: c => c.pe >= 3 },
  { key: 'chatty', name: 'Gesprächig', icon: 'message-circle', desc: '10 Chat-Nachrichten', test: c => c.ch >= 10 },
  { key: 'veteran', name: 'Veteran', icon: 'crown', desc: 'Level 5 erreicht', test: c => levelInfo(xpFromCounts(c)).level >= 5 },
];
const MEMBER_COUNTS_SQL = `SELECT u.id, u.name, u.created_at, u.admin, u.last_seen, s.avatar,
    (SELECT COUNT(*) FROM food_log WHERE user_id = u.id) fl,
    (SELECT COUNT(*) FROM weights WHERE user_id = u.id) w,
    (SELECT COUNT(*) FROM todos WHERE user_id = u.id AND done = 1) td,
    (SELECT COUNT(*) FROM appointments WHERE user_id = u.id) ap,
    (SELECT COUNT(*) FROM people WHERE user_id = u.id) pe,
    (SELECT COUNT(*) FROM dishes WHERE user_id = u.id AND source IN ('gemini','system')) pl,
    (SELECT COUNT(*) FROM transactions WHERE user_id = u.id) tx,
    (SELECT COUNT(*) FROM goals WHERE user_id = u.id) gl,
    (SELECT COUNT(*) FROM notes WHERE user_id = u.id) nt,
    (SELECT COUNT(*) FROM chat_messages WHERE user_id = u.id) ch
  FROM users u LEFT JOIN user_settings s ON s.user_id = u.id`;

// ---------- Community: Mitglieder & öffentlicher Chat ----------
app.get('/community/members', auth, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(MEMBER_COUNTS_SQL + ' ORDER BY u.id ASC LIMIT 200');
  res.json(rows.map(m => {
    const li = levelInfo(xpFromCounts(m));
    return { id: m.id, name: m.name, created_at: m.created_at, avatar: cleanAvatar(m.avatar), level: li.level, xp: li.xp, admin: !!m.admin, last_seen: m.last_seen };
  }));
}));

// Profil eines Mitglieds (für das Discord-artige Popout)
app.get('/community/member/:id', auth, asyncRoute(async (req, res) => {
  const [[c]] = await pool.execute(MEMBER_COUNTS_SQL + ' WHERE u.id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Nicht gefunden' });
  const li = levelInfo(xpFromCounts(c));
  const badges = BADGES.filter(b => b.test(c)).map(b => ({ key: b.key, name: b.name, icon: b.icon }));
  res.json({ id: c.id, name: c.name, avatar: cleanAvatar(c.avatar), admin: !!c.admin, created_at: c.created_at, last_seen: c.last_seen, ...li, badges });
}));

app.get('/community/stats', auth, asyncRoute(async (req, res) => {
  const [[c]] = await pool.execute(MEMBER_COUNTS_SQL + ' WHERE u.id = ?', [req.uid]);
  if (!c) return res.json({ level: 1, xp: 0, badges: [] });
  const li = levelInfo(xpFromCounts(c));
  const badges = BADGES.map(b => ({ key: b.key, name: b.name, icon: b.icon, desc: b.desc, earned: !!b.test(c) }));
  res.json({ ...li, badges, earnedCount: badges.filter(b => b.earned).length, totalBadges: badges.length });
}));
// ---------- Community: Kanäle (admin-verwaltet, alle schreiben) ----------
function slugifyChannel(s) {
  return String(s).toLowerCase().trim()
    .replace(/[äàáâ]/g, 'a').replace(/[öòóô]/g, 'o').replace(/[üùúû]/g, 'u').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kanal';
}
async function resolveChannel(ref) {
  if (ref === undefined || ref === null || ref === '') {
    const [[c]] = await pool.execute("SELECT * FROM channels WHERE slug = 'allgemein'");
    if (c) return c;
    const [[first]] = await pool.execute('SELECT * FROM channels ORDER BY position ASC, id ASC LIMIT 1');
    return first;
  }
  const byId = /^[0-9]+$/.test(String(ref));
  const [[c]] = await pool.execute('SELECT * FROM channels WHERE ' + (byId ? 'id = ?' : 'slug = ?'), [ref]);
  return c;
}

app.get('/community/channels', auth, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute('SELECT id, slug, name, description, is_readonly, position FROM channels ORDER BY position ASC, id ASC');
  res.json(rows.map(c => ({ id: c.id, slug: c.slug, name: c.name, description: c.description, is_readonly: !!c.is_readonly, position: c.position })));
}));
app.post('/community/channels', auth, requireAdmin, rateLimitUser('chan', 20), asyncRoute(async (req, res) => {
  const name = vStr(req.body.name, 'Kanalname', 60).trim();
  const description = req.body.description ? vStr(req.body.description, 'Beschreibung', 200) : null;
  const readonly = req.body.is_readonly !== undefined && vBool(req.body.is_readonly) ? 1 : 0;
  let base = slugifyChannel(name), slug = base, n = 1;
  while (true) {
    const [[dup]] = await pool.execute('SELECT id FROM channels WHERE slug = ?', [slug]);
    if (!dup) break;
    slug = base + '-' + (++n);
  }
  const [[mx]] = await pool.execute('SELECT COALESCE(MAX(position),-1)+1 p FROM channels');
  const [r] = await pool.execute('INSERT INTO channels (slug, name, description, position, is_readonly, created_by) VALUES (?,?,?,?,?,?)', [slug, name, description, mx.p, readonly, req.uid]);
  logEvent('info', 'channel_add', 'Kanal angelegt: ' + slug, { uid: req.uid, ip: reqIp(req) });
  res.json({ id: r.insertId, slug, name, description, is_readonly: !!readonly, position: mx.p });
}));
app.put('/community/channels/:id', auth, requireAdmin, rateLimitUser('chan', 20), asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Kanal', 1, 4294967295);
  const sets = [], vals = [];
  if (req.body.name !== undefined) { sets.push('name = ?'); vals.push(vStr(req.body.name, 'Kanalname', 60)); }
  if (req.body.description !== undefined) { sets.push('description = ?'); vals.push(req.body.description ? vStr(req.body.description, 'Beschreibung', 200) : null); }
  if (req.body.is_readonly !== undefined) { sets.push('is_readonly = ?'); vals.push(vBool(req.body.is_readonly) ? 1 : 0); }
  if (!sets.length) throw bad('Keine Felder zum Aktualisieren');
  vals.push(id);
  const [r] = await pool.execute('UPDATE channels SET ' + sets.join(', ') + ' WHERE id = ?', vals);
  if (!r.affectedRows) return res.status(404).json({ error: 'Kanal nicht gefunden' });
  res.json({ ok: true });
}));
app.delete('/community/channels/:id', auth, requireAdmin, rateLimitUser('chan', 20), asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Kanal', 1, 4294967295);
  const [[c]] = await pool.execute('SELECT slug FROM channels WHERE id = ?', [id]);
  if (!c) return res.status(404).json({ error: 'Kanal nicht gefunden' });
  if (c.slug === 'allgemein') throw bad('Der Kanal allgemein kann nicht gelöscht werden');
  await pool.execute('DELETE FROM chat_messages WHERE channel_id = ?', [id]);
  await pool.execute('DELETE FROM channels WHERE id = ?', [id]);
  logEvent('info', 'channel_del', 'Kanal gelöscht: ' + c.slug, { uid: req.uid, ip: reqIp(req) });
  res.json({ ok: true });
}));

const CHAT_SELECT = `SELECT c.id, c.user_id, c.content, c.created_at, u.name, u.username, u.admin, s.avatar
  FROM chat_messages c JOIN users u ON u.id = c.user_id LEFT JOIN user_settings s ON s.user_id = u.id`;
const mapChat = r => ({ id: r.id, user_id: r.user_id, content: r.content, created_at: r.created_at, name: r.name, username: r.username, admin: !!r.admin, avatar: cleanAvatar(r.avatar) });

app.get('/community/chat', auth, asyncRoute(async (req, res) => {
  const ch = await resolveChannel(req.query.channel);
  if (!ch) return res.status(404).json({ error: 'Kanal nicht gefunden' });
  const after = vInt(req.query.after, 'after', 0, Number.MAX_SAFE_INTEGER, { optional: true }) || 0;
  let rows;
  if (after > 0) {
    [rows] = await pool.execute(CHAT_SELECT + ' WHERE c.channel_id = ? AND c.id > ? ORDER BY c.id ASC LIMIT 60', [ch.id, after]);
  } else {
    [rows] = await pool.execute(CHAT_SELECT + ' WHERE c.channel_id = ? ORDER BY c.id DESC LIMIT 60', [ch.id]);
    rows.reverse();
  }
  res.json(rows.map(mapChat));
}));
app.post('/community/chat', auth, rateLimitUser('chat', 15), asyncRoute(async (req, res) => {
  const ch = await resolveChannel(req.body.channel);
  if (!ch) return res.status(404).json({ error: 'Kanal nicht gefunden' });
  if (ch.is_readonly) {
    const [[me]] = await pool.execute('SELECT admin FROM users WHERE id = ?', [req.uid]);
    if (!me || !me.admin) throw bad('In diesem Kanal können nur Admins schreiben');
  }
  const content = vStr(req.body.content, 'Nachricht', 500);
  const [r] = await pool.execute('INSERT INTO chat_messages (user_id, channel_id, content) VALUES (?,?,?)', [req.uid, ch.id, content]);
  const [[row]] = await pool.execute(CHAT_SELECT + ' WHERE c.id = ?', [r.insertId]);
  res.json(mapChat(row));
}));

// ---------- Cloud: Ordner & Dateien ----------
app.get('/cloud', auth, asyncRoute(async (req, res) => {
  const folderId = req.query.folder ? vInt(req.query.folder, 'Ordner', 1, 4294967295) : null;
  const q = vStr(req.query.q, 'Suche', 100, { optional: true });
  const cat = req.query.category ? vEnum(req.query.category, 'Kategorie', CLOUD_CATS) : null;
  const searching = !!(q || cat);
  let folders = [];
  if (!searching) {
    [folders] = await pool.execute(
      'SELECT id, name, created_at FROM cloud_folders WHERE user_id = ? AND ' + (folderId ? 'parent_id = ?' : 'parent_id IS NULL') + ' ORDER BY name ASC',
      folderId ? [req.uid, folderId] : [req.uid]);
  }
  const where = ['user_id = ?', "scan_status IN ('clean','legacy_unverified')"]; const params = [req.uid];
  if (q) { where.push('(name LIKE ? OR tags LIKE ?)'); const like = '%' + q + '%'; params.push(like, like); }
  else if (cat) { where.push('category = ?'); params.push(cat); }
  else { where.push(folderId ? 'folder_id = ?' : 'folder_id IS NULL'); if (folderId) params.push(folderId); }
  const [files] = await pool.execute(
    'SELECT id, folder_id, name, size, mime, category, tags, created_at FROM cloud_files WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT 500', params);
  const crumbs = [];
  let cur = folderId;
  for (let i = 0; i < 40 && cur; i++) {
    const [[f]] = await pool.execute('SELECT id, name, parent_id FROM cloud_folders WHERE id = ? AND user_id = ?', [cur, req.uid]);
    if (!f) break;
    crumbs.unshift({ id: f.id, name: f.name });
    cur = f.parent_id;
  }
  res.json({
    folders, breadcrumb: crumbs, searching,
    // SEC-004A: gespeicherter (client-gesetzter) MIME wird NICHT als vertrauenswuerdig ausgegeben.
    files: files.map(f => ({ ...f, mime: null, verified_mime: null, mime_verified: false, preview_allowed: false, tags: f.tags ? f.tags.split(',').filter(Boolean) : [] })),
    usage: await cloudUsage(req.uid), quota: await cloudQuota(req.uid),
  });
}));

app.post('/cloud/folders', auth, rateLimitUser('cloud-w', 40), asyncRoute(async (req, res) => {
  const name = vStr(req.body.name, 'Ordnername', 120);
  const parentId = req.body.parent_id ? vInt(req.body.parent_id, 'Ordner', 1, 4294967295) : null;
  if (parentId) { const [[p]] = await pool.execute('SELECT id FROM cloud_folders WHERE id=? AND user_id=?', [parentId, req.uid]); if (!p) throw bad('Übergeordneter Ordner nicht gefunden'); }
  const [r] = await pool.execute('INSERT INTO cloud_folders (user_id, name, parent_id) VALUES (?,?,?)', [req.uid, name, parentId]);
  res.json({ id: r.insertId, name });
}));
app.put('/cloud/folders/:id', auth, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Ordner', 1, 4294967295);
  const name = vStr(req.body.name, 'Ordnername', 120);
  const [r] = await pool.execute('UPDATE cloud_folders SET name=? WHERE id=? AND user_id=?', [name, id, req.uid]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Ordner nicht gefunden' });
  res.json({ ok: true });
}));
app.delete('/cloud/folders/:id', auth, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Ordner', 1, 4294967295);
  const [[own]] = await pool.execute('SELECT id FROM cloud_folders WHERE id=? AND user_id=?', [id, req.uid]);
  if (!own) return res.status(404).json({ error: 'Ordner nicht gefunden' });
  const ids = [id];
  for (let i = 0; i < ids.length && ids.length < 2000; i++) {
    const [subs] = await pool.execute('SELECT id FROM cloud_folders WHERE parent_id=? AND user_id=?', [ids[i], req.uid]);
    for (const s of subs) ids.push(s.id);
  }
  const [files] = await pool.query('SELECT stored_name FROM cloud_files WHERE user_id=? AND folder_id IN (?)', [req.uid, ids]);
  for (const f of files) { try { await fsp.unlink(safeCloudPath(req.uid, f.stored_name)); } catch (e) {} }
  await pool.query('DELETE FROM cloud_files WHERE user_id=? AND folder_id IN (?)', [req.uid, ids]);
  await pool.execute('DELETE FROM cloud_folders WHERE id=? AND user_id=?', [id, req.uid]);
  res.json({ ok: true });
}));

app.post('/cloud/upload', auth, rateLimitUser('cloud-up', 30), cloudUpload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw bad('Keine Datei empfangen');
  const qPath = req.file.path; // liegt in der Quarantaene
  const cleanupQ = async () => { try { await fsp.unlink(qPath); } catch (e) {} };
  try {
    const used = await cloudUsage(req.uid), quota = await cloudQuota(req.uid);
    if (used + req.file.size > quota) { await cleanupQ(); return res.status(413).json({ error: 'Dein Cloud-Speicher ist voll' }); }
    const folderId = req.body.folder_id ? parseInt(req.body.folder_id, 10) : null;
    if (folderId) { const [[p]] = await pool.execute('SELECT id FROM cloud_folders WHERE id=? AND user_id=?', [folderId, req.uid]); if (!p) { await cleanupQ(); throw bad('Ordner nicht gefunden'); } }
    const category = CLOUD_CATS.includes(req.body.category) ? req.body.category : 'sonstiges';
    // 1) Struktur-/Typvalidierung (Allowlist + Magic-Bytes + Struktur), niemals nur Endung/Client-MIME.
    const v = await validateUpload({ path: qPath, originalName: utf8name(req.file.originalname), size: req.file.size });
    if (!v.ok) {
      await cleanupQ();
      logEvent('warn', 'cloud_reject', 'Upload abgelehnt (' + v.reason + ', ' + req.file.size + ' B)', { uid: req.uid, ip: reqIp(req) });
      return res.status(415).json({ error: uploadRejectMsg(v.reason) });
    }
    // 2) Malware-Scan, fail-closed: Scanner-Fehler/Timeout => Datei wird NICHT freigegeben.
    let verdict;
    try { verdict = await scanFile(qPath); }
    catch (e) {
      await cleanupQ();
      logEvent('error', 'cloud_scan_fail', 'Malware-Scan nicht möglich: ' + String(e.message).slice(0, 120), { uid: req.uid, ip: reqIp(req) });
      return res.status(503).json({ error: 'Die Datei konnte gerade nicht geprüft werden. Bitte später erneut versuchen.' });
    }
    if (verdict === 'infected') {
      await cleanupQ();
      logEvent('warn', 'cloud_malware', 'Datei als schädlich abgelehnt (' + v.detectedType + ', ' + req.file.size + ' B)', { uid: req.uid, ip: reqIp(req) });
      return res.status(422).json({ error: 'Die Datei wurde als schädlich eingestuft und abgelehnt.' });
    }
    // 3) Erst jetzt ins Aktivverzeichnis uebernehmen. Quarantaene und Aktiv-Verzeichnis liegen im
    // systemd-Sandbox-Namespace auf getrennten Mounts (ReadWritePaths-Bind-Mount) => rename() faellt mit
    // EXDEV aus. Daher copyFile + Quarantaene loeschen. Die Datei ist erst nach dem DB-INSERT auffindbar
    // (Liste/Download brauchen die Zeile), der Kopiervorgang selbst ist also nie fuer Nutzer sichtbar.
    await ensureUserCloud(req.uid);
    const activePath = safeCloudPath(req.uid, req.file.filename);
    try { await fsp.copyFile(qPath, activePath); }
    catch (e) { await fsp.unlink(activePath).catch(() => {}); throw e; }
    await cleanupQ();
    // 4) SEC-004C: ATOMISCHE Quotenpruefung. Die users-Zeile wird gesperrt (FOR UPDATE), erst dann die
    // tatsaechliche Belegung innerhalb der Transaktion gelesen, geprueft und die Datei eingefuegt. Parallele
    // Uploads desselben Nutzers serialisieren sich an dieser Sperre und sehen die Summe erst nach dem Commit
    // des vorherigen => das Quota laesst sich nicht mehr per Race ueberschreiten. (Die fruehe Pruefung oben
    // bleibt als schneller, unverbindlicher Vorab-Reject fuer den Normalfall.)
    const conn = await pool.getConnection();
    let insertId;
    try {
      await conn.beginTransaction();
      const [[u]] = await conn.execute('SELECT cloud_quota FROM users WHERE id=? FOR UPDATE', [req.uid]);
      const quotaB = u ? Number(u.cloud_quota) : 2147483648;
      const [[s]] = await conn.execute('SELECT COALESCE(SUM(size),0) AS used FROM cloud_files WHERE user_id=?', [req.uid]);
      if (Number(s.used) + req.file.size > quotaB) {
        await conn.rollback();
        await fsp.unlink(activePath).catch(() => {});
        return res.status(413).json({ error: 'Dein Cloud-Speicher ist voll' });
      }
      const [r] = await conn.execute(
        'INSERT INTO cloud_files (user_id, folder_id, name, stored_name, size, mime, category, scan_status, mime_verified, detected_type, scanned_at) VALUES (?,?,?,?,?,?,?,?,?,?,NOW())',
        [req.uid, folderId, v.safeName, req.file.filename, req.file.size, v.mime, category, 'clean', 1, v.detectedType]);
      insertId = r.insertId;
      await conn.commit();
    } catch (e) {
      await conn.rollback().catch(() => {});
      await fsp.unlink(activePath).catch(() => {});
      throw e;
    } finally { conn.release(); }
    logEvent('info', 'cloud_upload', 'Datei hochgeladen (' + v.detectedType + ', ' + Math.round(req.file.size / 1024) + ' KB)', { uid: req.uid, ip: reqIp(req) });
    res.json({ id: insertId, name: v.safeName, size: req.file.size });
  } catch (e) { await cleanupQ(); throw e; }
}));

app.get('/cloud/file/:id', auth, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Datei', 1, 4294967295);
  const [[f]] = await pool.execute('SELECT name, stored_name, size, scan_status FROM cloud_files WHERE id=? AND user_id=?', [id, req.uid]);
  if (!f) return res.status(404).json({ error: 'Datei nicht gefunden' });
  // SEC-004B: nur geprüfte oder Alt-Bestandsdateien ausliefern, alles andere verbergen.
  if (f.scan_status && !['clean', 'legacy_unverified'].includes(f.scan_status)) return res.status(404).json({ error: 'Datei nicht verfügbar' });
  // SEC-004A: kein inline, kein client-MIME; sichere Oeffnung + Header im Modul.
  serveCloudFile(res, { diskPath: safeCloudPath(req.uid, f.stored_name), name: f.name, dbSize: f.size });
}));

app.put('/cloud/file/:id', auth, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Datei', 1, 4294967295);
  const [[f]] = await pool.execute('SELECT id FROM cloud_files WHERE id=? AND user_id=?', [id, req.uid]);
  if (!f) return res.status(404).json({ error: 'Datei nicht gefunden' });
  const sets = [], params = [];
  if (req.body.name !== undefined) { sets.push('name=?'); params.push(vStr(req.body.name, 'Name', 200)); }
  if (req.body.category !== undefined) { sets.push('category=?'); params.push(vEnum(req.body.category, 'Kategorie', CLOUD_CATS)); }
  if (req.body.tags !== undefined) {
    const t = Array.isArray(req.body.tags)
      ? req.body.tags.map(x => String(x).trim().replace(/,/g, ' ')).filter(Boolean).slice(0, 10).join(',')
      : (vStr(req.body.tags, 'Tags', 300, { optional: true }) || '');
    sets.push('tags=?'); params.push(t ? t.slice(0, 300) : null);
  }
  if (req.body.folder_id !== undefined) {
    const fid = req.body.folder_id ? vInt(req.body.folder_id, 'Ordner', 1, 4294967295) : null;
    if (fid) { const [[p]] = await pool.execute('SELECT id FROM cloud_folders WHERE id=? AND user_id=?', [fid, req.uid]); if (!p) throw bad('Ordner nicht gefunden'); }
    sets.push('folder_id=?'); params.push(fid);
  }
  if (!sets.length) throw bad('Nichts zu ändern');
  await pool.execute('UPDATE cloud_files SET ' + sets.join(', ') + ' WHERE id=? AND user_id=?', [...params, id, req.uid]);
  res.json({ ok: true });
}));

app.delete('/cloud/file/:id', auth, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Datei', 1, 4294967295);
  const [[f]] = await pool.execute('SELECT stored_name FROM cloud_files WHERE id=? AND user_id=?', [id, req.uid]);
  if (!f) return res.status(404).json({ error: 'Datei nicht gefunden' });
  await fsp.unlink(safeCloudPath(req.uid, f.stored_name)).catch(() => {});
  await pool.execute('DELETE FROM cloud_files WHERE id=? AND user_id=?', [id, req.uid]);
  res.json({ ok: true });
}));

// Essensplan: Slot setzen/überschreiben
app.put('/plan', auth, rateLimitUser('plan', 240), asyncRoute(async (req, res) => {
  const date = vDate(req.body.date, 'Datum');
  const meal = vEnum(req.body.meal, 'Mahlzeit', ['fruh', 'mittag', 'abend', 'snack']);
  const dishId = vInt(req.body.dish_id, 'Gericht', 1, 4294967295);
  const [[dish]] = await pool.execute('SELECT id FROM dishes WHERE id = ? AND user_id = ?', [dishId, req.uid]);
  if (!dish) throw bad('Gericht nicht gefunden');
  await pool.execute(
    'INSERT INTO meal_plan (user_id, `date`, meal, dish_id) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE dish_id = VALUES(dish_id)',
    [req.uid, date, meal, dishId]);
  res.json({ ok: true });
}));
app.delete('/plan/:date/:meal', auth, rateLimitUser('plan', 240), asyncRoute(async (req, res) => {
  const date = vDate(req.params.date, 'Datum');
  const meal = vEnum(req.params.meal, 'Mahlzeit', ['fruh', 'mittag', 'abend', 'snack']);
  await pool.execute('DELETE FROM meal_plan WHERE user_id = ? AND `date` = ? AND meal = ?', [req.uid, date, meal]);
  res.json({ ok: true });
}));

// ---------- Bootstrap: alles für den App-Start in einem Request ----------
// Abos: fehlende Monatsbuchungen ab Vertragsbeginn als echte Transaktionen nachtragen.
// Aktions-/Staffelpreise (phases) werden beruecksichtigt; nur vorwaerts (last_booked),
// damit vom Nutzer geloeschte Buchungen nicht wieder auftauchen. tag = 'abo:<id>'.
async function bookSubscriptions(uid) {
  const [subs] = await pool.execute("SELECT * FROM subscriptions WHERE user_id=? AND auto_book=1 AND start_date IS NOT NULL", [uid]);
  if (!subs.length) return;
  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  for (const s of subs) {
    const startStr = String(s.start_date).slice(0, 10);
    const startY0 = parseInt(startStr.slice(0, 4)), startM0 = parseInt(startStr.slice(5, 7)) - 1;
    if (!startY0) continue;
    let y = startY0, m = startM0;
    if (s.last_booked && /^\d{4}-\d{2}$/.test(s.last_booked)) {
      let ly = parseInt(s.last_booked.slice(0, 4)), lm = parseInt(s.last_booked.slice(5, 7)) - 1;
      lm++; if (lm > 11) { lm = 0; ly++; }
      if (ly > y || (ly === y && lm > m)) { y = ly; m = lm; }
    } else {
      const capD = new Date(now.getFullYear(), now.getMonth() - 120, 1);
      if (new Date(y, m, 1) < capD) { y = capD.getFullYear(); m = capD.getMonth(); }
    }
    const day = Math.min(31, Math.max(1, s.day || 1));
    const yearly = s.cycle === 'jährlich';
    let phases = [];
    try { phases = JSON.parse(s.phases || '[]'); } catch (e) {}
    let lastYm = s.last_booked || null;
    while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth())) {
      if (!yearly || m === startM0) {
        const idx = (y - startY0) * 12 + (m - startM0);
        let price = Number(s.price) || 0, acc = 0;
        for (const ph of phases) { const dur = parseInt(ph.m) || 0; if (idx < acc + dur) { price = parseFloat(ph.p) || 0; break; } acc += dur; }
        const dd = Math.min(day, new Date(y, m + 1, 0).getDate());
        const dateStr = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
        const cancelled = s.cancel_date && dateStr > String(s.cancel_date).slice(0, 10) && !(s.resume_date && String(s.resume_date).slice(0, 10) <= dateStr);
        if (idx >= 0 && dateStr <= today) {
          if (!cancelled && price > 0) {
            try { await pool.execute("INSERT INTO transactions (user_id, `date`, name, category, amount, tag, planned) VALUES (?,?,?,?,?,?,0)", [uid, dateStr, String(s.name).slice(0, 120), 'Abo', -Math.abs(price), 'abo:' + s.id]); } catch (e) {}
          }
          lastYm = y + '-' + String(m + 1).padStart(2, '0');
        }
      }
      m++; if (m > 11) { m = 0; y++; }
    }
    if (lastYm && lastYm !== s.last_booked) {
      await pool.execute("UPDATE subscriptions SET last_booked=? WHERE id=?", [lastYm, s.id]).catch(() => {});
    }
  }
}

app.get('/bootstrap', auth, asyncRoute(async (req, res) => {
  const uid = req.uid;
  await bookSubscriptions(uid).catch(() => {});
  const q = (sql, params = []) => pool.execute(sql, [uid, ...params]).then(([rows]) => rows);
  const [user, settings, weights, water, foodLog, dishes, plan, shopping,
    transactions, subscriptions, loans, goals, budgets, assets, dishRatings, todos, appointments, people, incomeSources, cooldowns] = await Promise.all([
    q('SELECT id, email, username, name, first_name, last_name, birthday, phone, street, zip, city, country, admin, developer, created_at FROM users WHERE id = ?').then(r => r[0]),
    q('SELECT * FROM user_settings WHERE user_id = ?').then(r => r[0]),
    q('SELECT id, `date`, kg FROM weights WHERE user_id = ? ORDER BY `date` ASC'),
    q('SELECT `date`, glasses FROM water_log WHERE user_id = ? AND `date` >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)'),
    q('SELECT * FROM food_log WHERE user_id = ? AND `date` >= DATE_SUB(CURDATE(), INTERVAL 60 DAY) ORDER BY id ASC'),
    q('SELECT * FROM dishes WHERE user_id = ? ORDER BY id ASC'),
    q('SELECT * FROM meal_plan WHERE user_id = ? AND `date` BETWEEN DATE_SUB(CURDATE(), INTERVAL 45 DAY) AND DATE_ADD(CURDATE(), INTERVAL 60 DAY)'),
    q('SELECT * FROM shopping_items WHERE user_id = ? ORDER BY id ASC'),
    q('SELECT * FROM transactions WHERE user_id = ? AND `date` >= DATE_SUB(CURDATE(), INTERVAL 400 DAY) ORDER BY `date` DESC, id DESC'),
    q('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY `day` ASC'),
    q('SELECT * FROM loans WHERE user_id = ? ORDER BY id ASC'),
    q('SELECT * FROM goals WHERE user_id = ? ORDER BY id ASC'),
    q('SELECT * FROM budgets WHERE user_id = ? ORDER BY id ASC'),
    q('SELECT * FROM assets WHERE user_id = ? ORDER BY value DESC'),
    q('SELECT name, liked FROM dish_ratings WHERE user_id = ?'),
    q('SELECT * FROM todos WHERE user_id = ? ORDER BY done ASC, id DESC'),
    q('SELECT * FROM appointments WHERE user_id = ? AND `date` >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) ORDER BY `date` ASC, `time` ASC'),
    q('SELECT * FROM people WHERE user_id = ? ORDER BY name ASC'),
    q('SELECT * FROM income_sources WHERE user_id = ? ORDER BY id DESC'),
    q('SELECT feature, used_at FROM ai_cooldown WHERE user_id = ?'),
  ]);
  // Cooldown-Enddaten (used_at + 7 Tage) pro Feature für die App
  const aiCooldowns = {};
  for (const c of cooldowns) aiCooldowns[c.feature] = new Date(new Date(c.used_at).getTime() + AI_COOLDOWN_DAYS * 86400000).toISOString();
  aiCooldowns.available = true;
  // PIN-Hash bleibt auf dem Server, der Client bekommt nur ob einer gesetzt ist
  const settingsSafe = settings ? { ...settings, avatar: cleanAvatar(settings.avatar) } : settings;
  res.json({ user, settings: settingsSafe, weights, water, foodLog, dishes, plan, shopping,
    transactions, subscriptions, loans, goals, budgets, assets, dishRatings, todos, appointments, people, incomeSources, aiCooldowns });
}));

// ---------- KI-Schicht entfernt: Analyse und Planung laufen systembasiert (siehe unten). ----------
// 7-Tage-Cooldown für Analysen (Insights, Spartipps); Admin kann ihn pro Nutzer zurücksetzen.
const AI_COOLDOWN_DAYS = 7;
async function cooldownStatus(uid, feature) {
  const [[row]] = await pool.execute('SELECT used_at FROM ai_cooldown WHERE user_id = ? AND feature = ?', [uid, feature]);
  if (!row) return { onCooldown: false, until: null };
  const until = new Date(new Date(row.used_at).getTime() + AI_COOLDOWN_DAYS * 86400000);
  return { onCooldown: until.getTime() > Date.now(), until: until.toISOString() };
}
async function setCooldown(uid, feature) {
  await pool.execute('INSERT INTO ai_cooldown (user_id, feature, used_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE used_at = NOW()', [uid, feature]);
}

// ---------- Systembasierte Ernährungsplanung (regelbasiert aus der Rezept-DB) ----------
// Kein KI-Anbieter: Gerichte werden deterministisch aus der eigenen Rezept-Datenbank
// (source='system', 1000+ handkuratierte Rezepte) nach Mahlzeit, Kalorienziel und
// Praeferenz-Tags gewaehlt, auf das Ziel skaliert und in dishes/meal_plan/shopping_items
// geschrieben. Gleiches Datenformat wie zuvor fuer den Client.
const ALL_MEALS = ['fruh', 'mittag', 'abend', 'snack'];
const MEAL_LABEL = { fruh: 'Frühstück', mittag: 'Mittagessen', abend: 'Abendessen', snack: 'Snack' };
const MEAL_BASE_W = { fruh: 30, mittag: 35, abend: 25, snack: 10 };
const PRICE_PER_KG = { 'Fleisch & Fisch': 12, 'Milch & Eier': 3, 'Proteine & Hülsenfrüchte': 4.5, 'Getreide & Basis': 2.5, 'Obst & Gemüse': 3, 'Fette & Öle': 7, 'Nüsse & Kerne': 13, 'Gewürze & Basics': 20, 'Sonstiges': 5 };
const TAG_WL = ['vegan', 'vegetarisch', 'laktosefrei', 'glutenfrei', 'high-protein', 'guenstig', 'schnell', 'low-carb', 'mealprep', 'fischfrei', 'schweinefrei', 'pilzfrei', 'nussfrei'];

// Ausschluesse aus den Personalisierungs-Antworten / prefs.exclude in harte Tags uebersetzen.
function exclusionTags(prefs, answers) {
  const src = (String(answers || '') + ' ' + (Array.isArray(prefs && prefs.exclude) ? prefs.exclude.join(' ') : '')).toLowerCase();
  const out = [];
  if (/pilz/.test(src)) out.push('pilzfrei');
  if (/n(ü|ue)ss|nuss/.test(src)) out.push('nussfrei');
  if (/schwein/.test(src)) out.push('schweinefrei');
  if (/fisch/.test(src)) out.push('fischfrei');
  return out;
}

function planTags(prefs) {
  const hard = [], soft = [];
  if (prefs.vegan) hard.push('vegan');
  else if (prefs.veggie) hard.push('vegetarisch');
  if (prefs.lactosefree) hard.push('laktosefrei');
  if (prefs.glutenfree) hard.push('glutenfrei');
  if (prefs.protein) soft.push('high-protein');
  if (prefs.cheap) soft.push('guenstig');
  if (prefs.fast) soft.push('schnell');
  if (prefs.lowcarb) soft.push('low-carb');
  if (prefs.mealprep) soft.push('mealprep');
  return { hard, soft };
}
function tagCond(t) { return TAG_WL.includes(t) ? "FIND_IN_SET('" + t + "', tags)" : '1'; }

// Waehlt count moeglichst passende, abwechslungsreiche Rezepte einer Mahlzeit.
async function pickRecipes(conn, meal, count, target, tags, exclude) {
  const ex = (exclude || []).slice(0, 40);
  const exClause = ex.length ? ' AND name NOT IN (' + ex.map(() => '?').join(',') + ')' : '';
  const query = async (soft) => {
    const conds = ["source='system'", 'meal = ?'].concat(tags.hard.map(tagCond)).concat(soft.map(tagCond));
    const [rows] = await conn.execute(
      'SELECT id,name,kcal,carbs,protein,fat,time_min,steps FROM recipes WHERE ' + conds.join(' AND ') + exClause + ' ORDER BY ABS(kcal - ?) LIMIT 80',
      [meal, ...ex, target]);
    return rows;
  };
  let soft = tags.soft.slice();
  let rows = await query(soft);
  while (rows.length < count && soft.length) { soft = soft.slice(0, -1); rows = await query(soft); }
  if (rows.length < count && tags.hard.length === 0) rows = await query([]);
  rows.sort((a, b) => Math.abs(a.kcal - target) - Math.abs(b.kcal - target));
  const pool = rows.slice(0, Math.max(count * 3, count + 4));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  return pool.slice(0, count);
}

// Ein Rezept auf die Ziel-Kalorien skalieren und als dishes-Zeile einfuegen.
async function insertScaledDish(conn, uid, r, target) {
  const factor = Math.max(0.65, Math.min(1.5, target / Math.max(1, r.kcal)));
  const [ings] = await conn.execute('SELECT name, amount_g FROM recipe_ingredients WHERE recipe_id = ?', [r.id]);
  const ingList = ings.map(x => Math.round(x.amount_g * factor) + ' g ' + x.name);
  let steps = [];
  try { steps = JSON.parse(r.steps) || []; } catch (e) {}
  const [ins] = await conn.execute(
    'INSERT INTO dishes (user_id, name, kcal, carbs, protein, fat, time_min, ingredients, steps, source, recipe_id, scale) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [uid, String(r.name).slice(0, 120),
      Math.round(r.kcal * factor), Math.round(r.carbs * factor), Math.round(r.protein * factor), Math.round(r.fat * factor),
      r.time_min || 0, JSON.stringify(ingList), JSON.stringify(steps), 'system', r.id, Math.round(factor * 100) / 100]);
  return ins.insertId;
}

// Eine Woche/Bereich des Plans aggregieren und als shopping_items schreiben (kein Loeschen).
async function buildShoppingRange(conn, uid, from, to, persons, weekNo) {
  const [rows] = await conn.execute(
    'SELECT ri.category AS cat, ri.name AS iname, SUM(ri.amount_g * d.scale) AS g' +
    ' FROM meal_plan mp JOIN dishes d ON d.id = mp.dish_id' +
    ' JOIN recipe_ingredients ri ON ri.recipe_id = d.recipe_id' +
    ' WHERE mp.user_id = ? AND mp.`date` BETWEEN ? AND ? AND d.recipe_id IS NOT NULL' +
    ' GROUP BY ri.category, ri.name ORDER BY ri.category, ri.name',
    [uid, from, to]);
  let n = 0;
  for (const row of rows) {
    const g = Math.round((Number(row.g) || 0) * persons);
    if (g <= 0) continue;
    const cat = row.cat || 'Sonstiges';
    let qty = g, unit = 'g';
    if (g >= 1000) { qty = Math.round(g / 100) / 10; unit = 'kg'; }
    const price = Math.round((g / 1000) * (PRICE_PER_KG[cat] || 5) * 100) / 100;
    await conn.execute(
      'INSERT INTO shopping_items (user_id, category, name, qty, unit, price, week_no) VALUES (?,?,?,?,?,?,?)',
      [uid, cat.slice(0, 60), String(row.iname).slice(0, 120), qty, unit, price, weekNo || 1]);
    n++;
  }
  return n;
}

// Einkaufsliste fuer den GESAMTEN Plan bauen, in 7-Tage-Wochen aufgeteilt (week_no 1..N).
async function buildShopping(conn, uid, dates, persons) {
  await conn.execute('DELETE FROM shopping_items WHERE user_id = ?', [uid]);
  let n = 0;
  const weeks = Math.ceil(dates.length / 7);
  for (let w = 0; w < weeks; w++) {
    const from = dates[w * 7];
    const to = dates[Math.min(dates.length - 1, w * 7 + 6)];
    n += await buildShoppingRange(conn, uid, from, to, persons, w + 1);
  }
  return n;
}

// Schreibende Plan-Operationen pro Nutzer serialisieren, damit sich zwei Requests
// (z.B. Doppelklick auf "Plan erstellen") nicht um dieselben Zeilen streiten.
const _userLocks = new Map();
function withUserLock(uid, fn) {
  const prev = _userLocks.get(uid) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  _userLocks.set(uid, next.then(() => {}, () => {}));
  return next;
}
function isTransientDbError(e) {
  const c = e && e.errno;
  return c === 1213 || c === 1205 || c === 1020 || (e && /Deadlock|Lock wait|Record has changed/i.test(e.message || ''));
}
// Transaktion pro Nutzer, seriell + mit kurzem Retry bei transienten Lock-Konflikten.
async function lockedTx(uid, body) {
  return withUserLock(uid, async () => {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const res = await body(conn);
        await conn.commit();
        conn.release();
        return res;
      } catch (e) {
        try { await conn.rollback(); } catch (_) {}
        conn.release();
        lastErr = e;
        if (isTransientDbError(e) && attempt < 3) { await new Promise(r => setTimeout(r, 60 * attempt)); continue; }
        throw e;
      }
    }
    throw lastErr;
  });
}

// Feste, sinnvolle Personalisierungsfragen (systembasiert, keine KI).
app.post('/ai/plan-questions', auth, asyncRoute(async (req, res) => {
  res.json({ questions: [
    { q: 'Gibt es Zutaten, die gar nicht gehen?', options: ['Schwein', 'Fisch', 'Pilze', 'Nüsse', 'Nichts davon'] },
    { q: 'Wie viel Zeit hast du zum Kochen?', options: ['Unter 15 Min', '15-30 Min', 'Egal, Hauptsache lecker'] },
    { q: 'Welche Küche magst du am liebsten?', options: ['Deutsch/Klassisch', 'Italienisch', 'Asiatisch', 'Orientalisch', 'Bunt gemischt'] },
    { q: 'Wie sollen die Portionen sein?', options: ['Eher leicht', 'Normal', 'Richtig sättigend'] },
  ] });
}));

// Systembasierter Ernaehrungsplan: waehlt Gerichte aus der Rezept-DB und baut Plan + Einkaufsliste.
app.post('/ai/plan', auth, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const prefs = b.prefs || {};
  const persons = vInt(b.persons, 'Personen', 1, 8, { optional: true }) || 1;
  const startDate = vDate(b.start_date, 'Startdatum');
  const days = vInt(b.days, 'Tage', 1, 62);
  const kcalGoal = vInt(b.kcal_goal, 'Kalorienziel', 1000, 5000, { optional: true }) || 2100;
  let meals = Array.isArray(b.meals) ? ALL_MEALS.filter(m => b.meals.includes(m)) : [];
  if (!meals.length) meals = ALL_MEALS.slice();
  const mealPrep = !!prefs.mealprep && meals.includes('mittag') && meals.includes('abend');
  const baseW = { ...MEAL_BASE_W };
  if (mealPrep) { baseW.mittag = 30; baseW.abend = 30; }
  const wSum = meals.reduce((s, m) => s + baseW[m], 0);
  const mealKcal = {};
  meals.forEach(m => { mealKcal[m] = Math.round(kcalGoal * baseW[m] / wSum); });
  // Je länger der Plan, desto mehr verschiedene Gerichte (die Rezept-DB mit 1000+ Gerichten
  // gibt das her), damit sich bei 3-4-Wochen-Plänen kaum etwas wiederholt.
  const MEAL_COUNT = days > 14 ? { fruh: 10, mittag: 14, abend: 14, snack: 8 }
    : days > 7 ? { fruh: 6, mittag: 9, abend: 9, snack: 5 }
    : { fruh: 4, mittag: 6, abend: 6, snack: 4 };
  const genMeals = meals.filter(m => !(mealPrep && m === 'abend'));

  const tags = planTags(prefs);
  for (const et of exclusionTags(prefs, b.answers)) if (!tags.hard.includes(et)) tags.hard.push(et);
  const [ratings] = await pool.execute('SELECT name, liked FROM dish_ratings WHERE user_id = ?', [req.uid]);
  const dislikes = ratings.filter(r => !r.liked).map(r => r.name);

  await lockedTx(req.uid, async (conn) => {
    const byMeal = { fruh: [], mittag: [], abend: [], snack: [] };
    for (const meal of genMeals) {
      const chosen = await pickRecipes(conn, meal, MEAL_COUNT[meal], mealKcal[meal], tags, dislikes);
      for (const r of chosen) byMeal[meal].push(await insertScaledDish(conn, req.uid, r, mealKcal[meal]));
    }
    if (mealPrep) byMeal.abend = byMeal.mittag;

    await conn.execute('DELETE FROM meal_plan WHERE user_id = ?', [req.uid]);
    const start = new Date(startDate + 'T00:00:00Z');
    const dates = [];
    for (let i = 0; i < days; i++) dates.push(new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));
    for (let i = 0; i < dates.length; i++) {
      for (const meal of meals) {
        const list = byMeal[meal];
        if (!list.length) continue;
        await conn.execute('INSERT INTO meal_plan (user_id, `date`, meal, dish_id) VALUES (?,?,?,?)', [req.uid, dates[i], meal, list[i % list.length]]);
      }
    }
    await conn.execute(
      "DELETE FROM dishes WHERE user_id = ? AND source IN ('gemini','system')" +
      ' AND id NOT IN (SELECT dish_id FROM meal_plan WHERE user_id = ?)' +
      ' AND id NOT IN (SELECT dish_id FROM food_log WHERE user_id = ? AND dish_id IS NOT NULL)',
      [req.uid, req.uid, req.uid]);
    await buildShopping(conn, req.uid, dates, persons);
  });

  if (b.answers) await pool.execute('UPDATE user_settings SET ki_answers = ? WHERE user_id = ?', [String(b.answers).slice(0, 2000), req.uid]);
  logEvent('info', 'ai_plan', 'Systemplan erstellt: ' + days + ' Tage, ' + meals.length + ' Mahlzeiten', { uid: req.uid, ip: req.ip });
  res.json({ ok: true });
}));

// Einzelne Mahlzeit neu wuerfeln: waehlt ein anderes Rezept aus der DB.
app.post('/ai/reroll-dish', auth, asyncRoute(async (req, res) => {
  const date = vDate(req.body.date, 'Datum');
  const meal = vEnum(req.body.meal, 'Mahlzeit', ALL_MEALS);
  const kcalTarget = vInt(req.body.kcal, 'Kalorien', 100, 3000, { optional: true }) || 600;
  const [ratings] = await pool.execute('SELECT name, liked FROM dish_ratings WHERE user_id = ?', [req.uid]);
  const dislikes = ratings.filter(r => !r.liked).map(r => r.name);
  const [[cur]] = await pool.execute(
    'SELECT d.name FROM meal_plan mp JOIN dishes d ON d.id = mp.dish_id WHERE mp.user_id = ? AND mp.`date` = ? AND mp.meal = ?',
    [req.uid, date, meal]);
  const exclude = cur ? dislikes.concat([cur.name]) : dislikes;
  let dishId, name;
  await lockedTx(req.uid, async (conn) => {
    const chosen = await pickRecipes(conn, meal, 1, kcalTarget, { hard: [], soft: [] }, exclude);
    if (!chosen.length) throw new HttpError(500, 'Kein passendes Gericht gefunden');
    dishId = await insertScaledDish(conn, req.uid, chosen[0], kcalTarget);
    name = chosen[0].name;
    await conn.execute(
      'INSERT INTO meal_plan (user_id, `date`, meal, dish_id) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE dish_id = VALUES(dish_id)',
      [req.uid, date, meal, dishId]);
  });
  logEvent('info', 'ai_reroll', MEAL_LABEL[meal] + ' am ' + date + ' neu gewürfelt: ' + String(name).slice(0, 80), { uid: req.uid, ip: req.ip });
  res.json({ ok: true, dish_id: dishId, name });
}));

// Einkaufsliste fuer einen Zeitraum des Plans neu berechnen (deterministisch aggregiert).
app.post('/ai/shopping-week', auth, asyncRoute(async (req, res) => {
  const from = vDate(req.body.from, 'Von-Datum');
  const to = vDate(req.body.to, 'Bis-Datum');
  const persons = vInt(req.body.persons, 'Personen', 1, 8, { optional: true }) || 1;
  const n = await lockedTx(req.uid, async (conn) => {
    await conn.execute('DELETE FROM shopping_items WHERE user_id = ?', [req.uid]);
    const cnt = await buildShoppingRange(conn, req.uid, from, to, persons, 1);
    if (!cnt) throw bad('In diesem Zeitraum ist nichts Passendes geplant');
    return cnt;
  });
  logEvent('info', 'ai_shopping', 'Einkaufsliste ' + from + ' bis ' + to + ' erstellt (' + n + ' Posten)', { uid: req.uid, ip: req.ip });
  res.json({ ok: true, count: n });
}));

// Naehrwert-Suche fuer den Tracker: sucht in der eigenen Food-DB (2,16 Mio Produkte).
app.post('/ai/food-lookup', auth, asyncRoute(async (req, res) => {
  const q = vStr(req.body.q, 'Suchbegriff', 120);
  const toks = q.toLowerCase().split(/[^a-z0-9äöüß]+/i).filter(t => t.length >= 3);
  let rows = [];
  if (toks.length) {
    const bool = toks.map(t => '+' + t + '*').join(' ');
    // Bevorzugt Produkte, deren Name mit dem Suchbegriff beginnt bzw. ihn enthält, dann kurze,
    // klare Namen (damit "banane" eine Banane trifft und nicht ein zufälliges kurzes Produkt).
    [rows] = await pool.execute(
      'SELECT name, kcal, carbs, protein, fat FROM foods WHERE MATCH(name, brand) AGAINST (? IN BOOLEAN MODE) ' +
      'ORDER BY (name LIKE ? AND kcal BETWEEN 20 AND 900) DESC, (name LIKE ?) DESC, ' +
      '(name LIKE ? AND kcal BETWEEN 20 AND 900) DESC, (kcal > 0) DESC, LENGTH(name) ASC LIMIT 1',
      [bool, toks[0] + '%', toks[0] + '%', '%' + toks[0] + '%']);
  }
  if (!rows.length) {
    // Fallback (auch für sehr kurze Begriffe unter der FULLTEXT-Mindestlänge, z.B. "Ei"):
    // Name beginnt mit dem Begriff + plausible Nährwerte + kurzer Name zuerst.
    [rows] = await pool.execute(
      'SELECT name, kcal, carbs, protein, fat FROM foods WHERE name LIKE ? ' +
      'ORDER BY (name LIKE ? AND kcal BETWEEN 20 AND 900) DESC, (name LIKE ?) DESC, (kcal > 0) DESC, LENGTH(name) ASC LIMIT 1',
      ['%' + q + '%', q + '%', q + '%']);
  }
  if (!rows.length) throw bad('Dazu habe ich keine Nährwerte gefunden');
  const f = rows[0];
  res.json({
    name: String(f.name || q).slice(0, 120),
    portion: '100 g',
    kcal: Math.max(0, Math.min(5000, Math.round(f.kcal) || 0)),
    carbs: Math.max(0, Math.min(1000, Math.round(f.carbs) || 0)),
    protein: Math.max(0, Math.min(1000, Math.round(f.protein) || 0)),
    fat: Math.max(0, Math.min(1000, Math.round(f.fat) || 0)),
  });
}));

// ---------- Systembasierte Analyse (regelbasiert, KEINE KI) ----------
// Insights und Spartipps werden vollständig deterministisch aus den Nutzerdaten
// berechnet. Kein externer KI-Anbieter, keine Kosten, gleiches Ergebnis bei gleichen Daten.
const INS_ICON = { finanzen: 'wallet', ernaehrung: 'apple', leben: 'calendar-heart', cloud: 'cloud', allgemein: 'sparkles' };
const INS_COLOR = { good: '#34d399', warn: '#fbbf24', bad: '#f87171', info: '#60a5fa' };
const TONE_RANK = { bad: 0, warn: 1, good: 2, info: 3 };

// Beträge deutsch formatieren, ohne von der Server-Locale abhängig zu sein.
function fmtEur(n) {
  let v = Math.round((Number(n) || 0) * 100) / 100;
  const neg = v < 0; v = Math.abs(v);
  const [i, dec] = v.toFixed(2).split('.');
  return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec + ' EUR';
}
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}
function subBase(name) {
  const t = normName(name).split(' ').filter(Boolean);
  return t[0] || normName(name);
}

// Sammelt die Rohdaten aller Module als strukturierte Zahlen (nicht als Text).
async function gatherInsightData(uid) {
  const q = (sql) => pool.execute(sql, [uid]).then(([r]) => r);
  const [subs, cats, months, loans, goals, budgets, food7, appts, todos, sett] = await Promise.all([
    q('SELECT name, price, cycle, cancel_date, resume_date FROM subscriptions WHERE user_id = ?'),
    q("SELECT category, ROUND(SUM(-amount),2) AS spent FROM transactions WHERE user_id = ? AND planned = 0 AND amount < 0 AND `date` >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) GROUP BY category ORDER BY spent DESC LIMIT 8"),
    q("SELECT DATE_FORMAT(`date`, '%Y-%m') AS ym, ROUND(SUM(GREATEST(amount,0)),2) AS ein, ROUND(SUM(GREATEST(-amount,0)),2) AS aus FROM transactions WHERE user_id = ? AND planned = 0 AND `date` >= DATE_SUB(CURDATE(), INTERVAL 90 DAY) GROUP BY ym ORDER BY ym"),
    q('SELECT name, balance, rate, interest FROM loans WHERE user_id = ?'),
    q('SELECT name, saved, target FROM goals WHERE user_id = ?'),
    q('SELECT category, limit_amount FROM budgets WHERE user_id = ?'),
    q("SELECT COUNT(*) AS days, ROUND(AVG(d.kcal), 0) AS avgk FROM (SELECT `date`, SUM(kcal) AS kcal FROM food_log WHERE user_id = ? AND `date` >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) GROUP BY `date`) d"),
    q("SELECT title, DATEDIFF(`date`, CURDATE()) AS din FROM appointments WHERE user_id = ? AND `date` >= CURDATE() AND `date` <= DATE_ADD(CURDATE(), INTERVAL 21 DAY) ORDER BY `date`, `time` LIMIT 20"),
    q('SELECT COUNT(*) AS open FROM todos WHERE user_id = ? AND done = 0'),
    q('SELECT ziel_typ, target_weight FROM user_settings WHERE user_id = ?'),
  ]);
  const dn = new Date();
  const today = dn.getFullYear() + '-' + String(dn.getMonth() + 1).padStart(2, '0') + '-' + String(dn.getDate()).padStart(2, '0');
  const activeSubs = subs
    .filter(s => !s.cancel_date || s.cancel_date > today || (s.resume_date && s.resume_date <= today))
    .map(s => ({ name: s.name, price: Number(s.price) || 0, cycle: s.cycle, monthly: (Number(s.price) || 0) / (s.cycle === 'jährlich' ? 12 : 1) }));
  const subMonthly = activeSubs.reduce((a, s) => a + s.monthly, 0);
  const used = await cloudUsage(uid), quota = await cloudQuota(uid);
  const zt = sett[0] ? (parseInt(sett[0].ziel_typ) || 0) : 0;
  return {
    activeSubs, subMonthly,
    cats: cats.map(c => ({ category: c.category, spent: Number(c.spent) || 0 })),
    months: months.map(m => ({ ym: m.ym, ein: Number(m.ein) || 0, aus: Number(m.aus) || 0 })),
    loans: loans.map(l => ({ name: l.name, balance: Number(l.balance) || 0, rate: Number(l.rate) || 0, interest: Number(l.interest) || 0 })),
    goals: goals.map(g => ({ name: g.name, saved: Number(g.saved) || 0, target: Number(g.target) || 0, pct: g.target > 0 ? g.saved / g.target : 0 })),
    budgets: budgets.map(b => ({ category: b.category, limit: Number(b.limit_amount) || 0 })),
    food: { days: food7[0].days || 0, avgk: food7[0].avgk || 0 },
    zielTyp: zt < 0 ? -1 : zt > 0 ? 1 : 0,
    todosOpen: todos[0].open || 0,
    appts: appts.map(a => ({ title: a.title, din: a.din })),
    cloudUsed: used, cloudQuota: quota,
  };
}

// Regelwerk: erzeugt aus den Rohdaten modulübergreifende Erkenntnisse (max. 8).
function computeInsights(d) {
  const out = [];
  const add = (category, tone, title, text) => out.push({ category, tone, title, text });

  // FINANZEN: Doppel-Abos (gleicher Namensstamm, z.B. zwei Netflix)
  const byBase = {};
  for (const s of d.activeSubs) { const k = subBase(s.name); (byBase[k] = byBase[k] || []).push(s); }
  for (const k of Object.keys(byBase)) {
    const g = byBase[k];
    if (g.length >= 2) {
      const sum = g.reduce((a, s) => a + s.monthly, 0);
      add('finanzen', 'warn', 'Mögliches Doppel-Abo',
        `Du hast ${g.length} aktive Abos die zu "${g[0].name}" passen (${g.map(s => s.name).join(', ')}), zusammen ${fmtEur(sum)}/Monat. Prüf, ob du wirklich beide brauchst.`);
    }
  }
  // FINANZEN: teuerster Kredit
  const loanHi = d.loans.filter(l => l.interest >= 0.05).sort((a, b) => b.interest - a.interest)[0];
  if (loanHi) add('finanzen', 'warn', 'Teurer Kredit läuft',
    `${loanHi.name}: noch ${fmtEur(loanHi.balance)} Restschuld bei ${(loanHi.interest * 100).toFixed(1)}% Zins. Eine Sondertilgung spart dir hier am meisten.`);
  // FINANZEN: Monatsbilanz
  if (d.months.length) {
    const m = d.months[d.months.length - 1];
    const diff = m.ein - m.aus;
    if (m.aus > m.ein && m.aus > 0) add('finanzen', diff < -200 ? 'bad' : 'warn', 'Mehr ausgegeben als eingenommen',
      `Im Zeitraum ${m.ym} stehen ${fmtEur(m.ein)} Einnahmen ${fmtEur(m.aus)} Ausgaben gegenüber, ein Minus von ${fmtEur(-diff)}.`);
    else if (diff > 50) add('finanzen', 'good', 'Überschuss diesen Monat',
      `In ${m.ym} bleibt dir ein Plus von ${fmtEur(diff)}. Leg es direkt auf ein Sparziel, dann ist es weg vom Girokonto.`);
  }
  // FINANZEN: Budget überzogen
  for (const b of d.budgets) {
    if (b.limit <= 0) continue;
    const c = d.cats.find(x => normName(x.category) === normName(b.category));
    if (c && c.spent > b.limit) add('finanzen', 'warn', `Budget überzogen: ${b.category}`,
      `Du hast in 30 Tagen ${fmtEur(c.spent)} für ${b.category} ausgegeben, dein Budget liegt bei ${fmtEur(b.limit)}.`);
  }
  // FINANZEN: Sparziel erreicht / fast erreicht
  const goalsSorted = d.goals.slice().sort((a, b) => b.pct - a.pct);
  const goalDone = goalsSorted.find(g => g.target > 0 && g.pct >= 1);
  if (goalDone) add('finanzen', 'good', `Sparziel erreicht: ${goalDone.name}`,
    `Stark, ${goalDone.name} ist mit ${fmtEur(goalDone.saved)} voll finanziert. Zeit, das Geld einzusetzen oder ein neues Ziel zu setzen.`);
  const goalNear = goalsSorted.find(g => g.target > 0 && g.pct >= 0.8 && g.pct < 1);
  if (goalNear) add('finanzen', 'info', `Fast am Ziel: ${goalNear.name}`,
    `${goalNear.name} steht bei ${Math.round(goalNear.pct * 100)}% (${fmtEur(goalNear.saved)} von ${fmtEur(goalNear.target)}). Nur noch ${fmtEur(goalNear.target - goalNear.saved)} fehlen.`);
  // FINANZEN: hohe Abo-Last (nur falls kein Doppel-Abo gemeldet)
  if (d.subMonthly >= 40 && !out.some(i => i.title === 'Mögliches Doppel-Abo'))
    add('finanzen', 'info', 'Deine Abos summieren sich',
      `${d.activeSubs.length} aktive Abos kosten dich ${fmtEur(d.subMonthly)}/Monat, also ${fmtEur(d.subMonthly * 12)}/Jahr.`);
  // FINANZEN: größter Posten (nur wenn sonst noch kein Finanz-Insight)
  if (d.cats.length && !out.some(i => i.category === 'finanzen')) {
    const top = d.cats[0];
    add('finanzen', 'info', `Größter Ausgabenposten: ${top.category}`,
      `${top.category} war in den letzten 30 Tagen mit ${fmtEur(top.spent)} dein größter Posten.`);
  }

  // ERNÄHRUNG
  if (d.zielTyp < 0 && d.food.days === 0)
    add('ernaehrung', 'warn', 'Kein Tracking bei Abnehmziel',
      'Dein Ziel ist Abnehmen, aber in den letzten 7 Tagen hast du nichts getrackt. Ohne Tracking fehlt dir der Überblick über die Kalorien.');
  else if (d.food.days >= 6)
    add('ernaehrung', 'good', 'Starkes Ess-Tracking',
      `Du hast an ${d.food.days} der letzten 7 Tage getrackt (Ø ${d.food.avgk} kcal/Tag). Weiter so, so bleibt dein Ziel realistisch.`);
  else if (d.food.days >= 1 && d.food.days <= 3)
    add('ernaehrung', 'info', 'Tracking noch lückenhaft',
      `Du hast nur an ${d.food.days} von 7 Tagen getrackt. Ein paar Tage mehr geben ein deutlich klareres Bild.`);

  // LEBEN: gleiche Termine mehrfach
  const byTitle = {};
  for (const a of d.appts) { const k = normName(a.title); (byTitle[k] = byTitle[k] || []).push(a); }
  for (const k of Object.keys(byTitle)) {
    if (byTitle[k].length >= 2) {
      const g = byTitle[k];
      add('leben', 'info', `Mehrere Termine: ${g[0].title}`,
        `Du hast ${g.length} anstehende Termine namens "${g[0].title}". Prüf, ob sich das zusammenlegen lässt.`);
      break;
    }
  }
  // LEBEN: volle Woche
  const soon = d.appts.filter(a => a.din >= 0 && a.din <= 7).length;
  if (soon >= 3) add('leben', 'info', 'Volle Woche',
    `In den nächsten 7 Tagen stehen ${soon} Termine an. Plan dir genug Puffer dazwischen ein.`);
  // LEBEN: viele offene Aufgaben
  if (d.todosOpen >= 8) add('leben', 'warn', `${d.todosOpen} offene Aufgaben`,
    `Deine To-do-Liste ist auf ${d.todosOpen} offene Punkte gewachsen. Nimm dir die 3 wichtigsten zuerst vor.`);

  // CLOUD
  if (d.cloudQuota > 0) {
    const ratio = d.cloudUsed / d.cloudQuota;
    if (d.cloudUsed === 0) add('cloud', 'info', 'Cloud-Speicher ungenutzt',
      `Du hast ${(d.cloudQuota / 1073741824).toFixed(0)} GB Cloud frei, aber noch keine Datei abgelegt. Leg wichtige Dokumente dort ab, dann hast du sie überall.`);
    else if (ratio >= 0.85) add('cloud', 'warn', 'Cloud fast voll',
      `Dein Cloud-Speicher ist zu ${Math.round(ratio * 100)}% belegt. Räum ein paar große Dateien weg oder erweitere den Platz.`);
  }

  out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
  return out.slice(0, 8);
}

// Regelwerk: konkrete Spartipps mit bezifferter monatlicher Ersparnis (max. 5).
function computeSavingsTips(d) {
  const out = [];
  const add = (title, text, saving) => out.push({ title, text, saving: Math.max(0, Math.round((saving || 0) * 100) / 100) });
  const byBase = {};
  for (const s of d.activeSubs) { const k = subBase(s.name); (byBase[k] = byBase[k] || []).push(s); }
  for (const k of Object.keys(byBase)) {
    const g = byBase[k];
    if (g.length >= 2) {
      const cheaper = g.slice().sort((a, b) => a.monthly - b.monthly)[0];
      add(`Doppel-Abo bei ${g[0].name} kündigen`, `Du zahlst ${g.length}x für "${g[0].name}". Kündigst du das günstigere, sparst du sofort.`, cheaper.monthly);
    }
  }
  const loanHi = d.loans.filter(l => l.interest > 0).sort((a, b) => b.interest - a.interest)[0];
  if (loanHi) add(`Kredit "${loanHi.name}" schneller tilgen`,
    `Bei ${(loanHi.interest * 100).toFixed(1)}% Zins auf ${fmtEur(loanHi.balance)} zahlst du rund ${fmtEur(loanHi.balance * loanHi.interest / 12)} im Monat nur an Zinsen. Sondertilgung lohnt sich.`,
    loanHi.balance * loanHi.interest / 12);
  for (const b of d.budgets) {
    if (b.limit <= 0) continue;
    const c = d.cats.find(x => normName(x.category) === normName(b.category));
    if (c && c.spent > b.limit) add(`Weniger für ${b.category}`,
      `${fmtEur(c.spent)} in 30 Tagen liegen über deinem Budget von ${fmtEur(b.limit)}. Zurück aufs Limit spart dir die Differenz.`, c.spent - b.limit);
  }
  if (out.length < 3 && d.cats.length) {
    const top = d.cats.find(c => !d.budgets.some(b => normName(b.category) === normName(c.category))) || d.cats[0];
    add(`${top.category} ist dein größter Posten`, `${fmtEur(top.spent)} in 30 Tagen für ${top.category}. Schon 10% weniger bringen dir ${fmtEur(top.spent * 0.1)}/Monat.`, top.spent * 0.1);
  }
  if (out.length < 3 && d.subMonthly >= 30) add('Abos ausmisten',
    `Deine Abos kosten ${fmtEur(d.subMonthly)}/Monat. Kündigst du eins, das du selten nutzt, ist das direkt gespart.`, d.subMonthly * 0.25);
  return out.slice(0, 5);
}
app.post('/ai/savings-tips', auth, asyncRoute(async (req, res) => {
  const uid = req.uid;
  // Systembasiert und guenstig, daher kein Cooldown mehr: jederzeit neu berechenbar.
  const d = await gatherInsightData(uid);
  const tips = computeSavingsTips(d);
  if (!tips.length) return res.status(422).json({ error: 'Noch zu wenig Finanzdaten für Spartipps. Trag Abos, Ausgaben, Budgets oder Kredite ein.' });
  logEvent('info', 'ai_tips', 'Spartipps berechnet (' + tips.length + ' Tipps)', { uid, ip: req.ip });
  res.json({ tips, until: null });
}));

// ---------- Insights: modulübergreifende systembasierte Analyse ----------
app.post('/ai/insights', auth, asyncRoute(async (req, res) => {
  const uid = req.uid;
  // Kein Cooldown mehr: der Client scannt automatisch im Hintergrund (alle 10-15 Min).
  const d = await gatherInsightData(uid);
  const items = computeInsights(d).map(i => ({
    category: INS_ICON[i.category] ? i.category : 'allgemein',
    icon: INS_ICON[INS_ICON[i.category] ? i.category : 'allgemein'],
    color: INS_COLOR[i.tone] || INS_COLOR.info,
    title: String(i.title || '').slice(0, 140),
    text: String(i.text || '').slice(0, 600),
  })).filter(i => i.title && i.text);
  if (!items.length) return res.status(422).json({ error: 'Noch zu wenig Daten für Insights. Trag ein paar Ausgaben, Mahlzeiten oder Termine ein, dann analysiere ich das für dich.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM insights WHERE user_id = ?', [uid]);
    for (const i of items) {
      await conn.execute('INSERT INTO insights (user_id, icon, category, color, title, text) VALUES (?, ?, ?, ?, ?, ?)',
        [uid, i.icon, i.category, i.color, i.title, i.text]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

  // NutriBot-Hinweis nur 1x pro Tag (dedupe ueber ref=Datum), damit der Autoscan nicht spammt.
  await botPost(uid, 'insights', new Date().toISOString().slice(0, 10), 'sparkles', '#a78bfa',
    'Neue Insights für dich', `Ich habe ${items.length} neue Erkenntnisse aus deinen Daten gezogen.`);
  logEvent('info', 'ai_insights', 'Insights generiert (' + items.length + ')', { uid, ip: req.ip });
  res.json({ insights: items, until: null });
}));

app.get('/ai/insights', auth, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute('SELECT icon, category, color, title, text, created_at FROM insights WHERE user_id = ? ORDER BY id ASC', [req.uid]);
  res.json({ insights: rows, until: null, available: true });
}));

// ---------- Support-Tickets -> eigenes Board (Liste "Offen") ----------
// ---------- Support-Board (eigenes, selbst gehostet) ----------
const BOARD_CAT_COLOR = { bug: '#fb923c', idee: '#a78bfa', frage: '#2dd4bf', feature: '#a3e635' };
async function boardListBySlug(slug) { const [[l]] = await pool.execute('SELECT * FROM board_lists WHERE slug = ?', [slug]); return l; }
async function nextCardPos(listId) { const [[r]] = await pool.execute('SELECT COALESCE(MAX(position),-1)+1 p FROM board_cards WHERE list_id = ?', [listId]); return r.p; }
async function cardActorName(uid) { if (!uid) return 'System'; const [[u]] = await pool.execute('SELECT name, username FROM users WHERE id = ?', [uid]); return u ? (u.name || u.username || 'Nutzer') : 'Nutzer'; }
async function logCardActivity(cardId, uid, text) { await pool.execute("INSERT INTO board_comments (card_id, user_id, kind, text) VALUES (?,?,'activity',?)", [cardId, uid, text]); }
function mapBoardCard(c) {
  return {
    id: c.id, list_id: c.list_id, title: c.title, description: c.description || '',
    category: c.category || null, catColor: c.category ? (BOARD_CAT_COLOR[c.category] || 'var(--mut)') : null,
    version: c.version || null, due_date: c.due_date ? String(c.due_date).slice(0, 10) : null,
    type: c.type, done: !!c.done, user_id: c.user_id, authorName: c.authorName || null,
    commentCount: Number(c.cc || 0), hasDesc: !!(c.description && String(c.description).trim()), hasAttach: Number(c.ac || 0) > 0,
    position: c.position,
  };
}
async function loadCardFeed(cardId) {
  const [rows] = await pool.execute(
    `SELECT bc.id, bc.user_id, bc.kind, bc.text, bc.created_at, u.name authorName
     FROM board_comments bc LEFT JOIN users u ON u.id = bc.user_id WHERE bc.card_id = ? ORDER BY bc.id ASC`, [cardId]);
  return rows.map(r => ({ id: r.id, kind: r.kind, text: r.text, created_at: r.created_at, user_id: r.user_id, authorName: r.authorName || 'System' }));
}

app.post('/support/ticket', auth, rateLimitUser('ticket', 20), asyncRoute(async (req, res) => {
  const type = vEnum(req.body.type, 'Typ', ['Bug', 'Idee', 'Frage'], { optional: true }) || 'Bug';
  const title = vStr(req.body.title, 'Titel', 120);
  const text = vStr(req.body.text, 'Beschreibung', 4000, { optional: true }) || '';
  const image = typeof req.body.image === 'string' ? req.body.image : '';
  const offen = await boardListBySlug('offen');
  if (!offen) throw new HttpError(503, 'Der Support ist gerade nicht verfügbar.');
  const pos = await nextCardPos(offen.id);
  const [r] = await pool.execute(
    "INSERT INTO board_cards (list_id, title, description, category, type, user_id, created_by, position) VALUES (?,?,?,?,'ticket',?,?,?)",
    [offen.id, title, text, type.toLowerCase(), req.uid, req.uid, pos]);
  const cardId = r.insertId;
  if (image && /^data:image\/(png|jpe?g|webp);base64,/.test(image) && image.length < 8 * 1024 * 1024) {
    try { await pool.execute('INSERT INTO board_attachments (card_id, data_uri) VALUES (?,?)', [cardId, image]); } catch (e) {}
  }
  await logCardActivity(cardId, req.uid, (await cardActorName(req.uid)) + ' hat dieses Ticket erstellt');
  logEvent('info', 'support_ticket', type + ': ' + title.slice(0, 80), { uid: req.uid, ip: reqIp(req) });
  res.json({ ok: true, id: cardId });
}));

// ----- Admin: Board -----
app.get('/board', auth, requireAdmin, asyncRoute(async (req, res) => {
  const [lists] = await pool.execute('SELECT id, slug, name, dot, position FROM board_lists ORDER BY position ASC, id ASC');
  const [cards] = await pool.execute(
    `SELECT c.*, u.name authorName,
       (SELECT COUNT(*) FROM board_comments bc WHERE bc.card_id=c.id AND bc.kind='comment') cc,
       (SELECT COUNT(*) FROM board_attachments ba WHERE ba.card_id=c.id) ac
     FROM board_cards c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.position ASC, c.id ASC`);
  res.json({ lists, cards: cards.map(mapBoardCard) });
}));
app.post('/board/cards', auth, requireAdmin, rateLimitUser('board', 120), asyncRoute(async (req, res) => {
  const listId = vInt(req.body.list_id, 'Liste', 1, 4294967295);
  const title = vStr(req.body.title, 'Titel', 200);
  const [[l]] = await pool.execute('SELECT id FROM board_lists WHERE id = ?', [listId]);
  if (!l) throw bad('Liste nicht gefunden');
  const pos = await nextCardPos(listId);
  const [r] = await pool.execute("INSERT INTO board_cards (list_id, title, type, created_by, position) VALUES (?,?,'roadmap',?,?)", [listId, title, req.uid, pos]);
  await logCardActivity(r.insertId, req.uid, (await cardActorName(req.uid)) + ' hat diese Karte erstellt');
  res.json({ ok: true, id: r.insertId });
}));
app.put('/board/cards/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Karte', 1, 4294967295);
  const b = req.body; const sets = [], vals = [];
  if (b.title !== undefined) { sets.push('title=?'); vals.push(vStr(b.title, 'Titel', 200)); }
  if (b.description !== undefined) { sets.push('description=?'); vals.push(b.description ? vStr(b.description, 'Beschreibung', 8000) : null); }
  if (b.category !== undefined) { sets.push('category=?'); vals.push(b.category ? vStr(b.category, 'Label', 20).toLowerCase() : null); }
  if (b.version !== undefined) { sets.push('version=?'); vals.push(b.version ? vStr(b.version, 'Version', 20) : null); }
  if (b.due_date !== undefined) { sets.push('due_date=?'); vals.push(b.due_date ? vDate(b.due_date, 'Datum', { optional: true }) : null); }
  if (b.ticket_id !== undefined) { sets.push('ticket_id=?'); vals.push(b.ticket_id ? vInt(b.ticket_id, 'Ticket', 1, 4294967295) : null); }
  if (b.done !== undefined) { sets.push('done=?'); vals.push(vBool(b.done) ? 1 : 0); }
  if (!sets.length) throw bad('Nichts zu ändern');
  vals.push(id);
  const [r] = await pool.execute('UPDATE board_cards SET ' + sets.join(', ') + ' WHERE id=?', vals);
  if (!r.affectedRows) return res.status(404).json({ error: 'Karte nicht gefunden' });
  res.json({ ok: true });
}));
app.post('/board/cards/:id/move', auth, requireAdmin, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Karte', 1, 4294967295);
  const listId = vInt(req.body.list_id, 'Liste', 1, 4294967295);
  const position = vInt(req.body.position, 'Position', 0, 1000000, { optional: true }) || 0;
  const [[card]] = await pool.execute('SELECT list_id FROM board_cards WHERE id=?', [id]);
  if (!card) return res.status(404).json({ error: 'Karte nicht gefunden' });
  const [[l]] = await pool.execute('SELECT slug, name FROM board_lists WHERE id=?', [listId]);
  if (!l) throw bad('Liste nicht gefunden');
  await pool.execute('UPDATE board_cards SET position = position + 1 WHERE list_id=? AND position >= ? AND id <> ?', [listId, position, id]);
  await pool.execute('UPDATE board_cards SET list_id=?, position=?, done=? WHERE id=?', [listId, position, l.slug === 'done' ? 1 : 0, id]);
  if (card.list_id !== listId) await logCardActivity(id, req.uid, (await cardActorName(req.uid)) + ' hat diese Karte zu ' + l.name + ' verschoben');
  res.json({ ok: true });
}));
app.delete('/board/cards/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Karte', 1, 4294967295);
  await pool.execute('DELETE FROM board_comments WHERE card_id=?', [id]);
  await pool.execute('DELETE FROM board_attachments WHERE card_id=?', [id]);
  const [r] = await pool.execute('DELETE FROM board_cards WHERE id=?', [id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Karte nicht gefunden' });
  res.json({ ok: true });
}));
app.get('/board/cards/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Karte', 1, 4294967295);
  const [[c]] = await pool.execute('SELECT c.*, u.name authorName, u.email authorEmail, (SELECT subject FROM tickets t WHERE t.id=c.ticket_id) ticketSubject FROM board_cards c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?', [id]);
  if (!c) return res.status(404).json({ error: 'Karte nicht gefunden' });
  const [atts] = await pool.execute('SELECT id FROM board_attachments WHERE card_id=?', [id]);
  res.json({ card: { ...mapBoardCard(c), authorEmail: c.authorEmail || null, ticket_id: c.ticket_id || null, ticketSubject: c.ticketSubject || null }, feed: await loadCardFeed(id), attachments: atts.map(a => a.id) });
}));
app.post('/board/cards/:id/comment', auth, requireAdmin, rateLimitUser('board', 120), asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Karte', 1, 4294967295);
  const text = vStr(req.body.text, 'Kommentar', 4000);
  const [[c]] = await pool.execute('SELECT id FROM board_cards WHERE id=?', [id]);
  if (!c) return res.status(404).json({ error: 'Karte nicht gefunden' });
  await pool.execute("INSERT INTO board_comments (card_id, user_id, kind, text) VALUES (?,?,'comment',?)", [id, req.uid, text]);
  await pool.execute('UPDATE board_cards SET updated_at=CURRENT_TIMESTAMP WHERE id=?', [id]);
  res.json({ ok: true });
}));
app.post('/board/lists', auth, requireAdmin, rateLimitUser('board', 120), asyncRoute(async (req, res) => {
  const name = vStr(req.body.name, 'Listenname', 60);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || ('liste-' + Date.now());
  const [[mx]] = await pool.execute('SELECT COALESCE(MAX(position),-1)+1 p FROM board_lists');
  try { const [r] = await pool.execute('INSERT INTO board_lists (slug, name, dot, position) VALUES (?,?,?,?)', [slug, name, 'var(--mut)', mx.p]); res.json({ ok: true, id: r.insertId, slug }); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw bad('Liste existiert schon'); throw e; }
}));
app.delete('/board/lists/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Liste', 1, 4294967295);
  const [[cnt]] = await pool.execute('SELECT COUNT(*) n FROM board_cards WHERE list_id=?', [id]);
  if (cnt.n > 0) throw bad('Liste ist nicht leer');
  const [[l]] = await pool.execute('SELECT slug FROM board_lists WHERE id=?', [id]);
  if (l && ['offen', 'done'].includes(l.slug)) throw bad('Diese Liste kann nicht gelöscht werden');
  await pool.execute('DELETE FROM board_lists WHERE id=?', [id]);
  res.json({ ok: true });
}));
app.get('/board/attachments/:id', auth, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Anhang', 1, 4294967295);
  const [[a]] = await pool.execute('SELECT ba.data_uri, bc.user_id FROM board_attachments ba JOIN board_cards bc ON bc.id=ba.card_id WHERE ba.id=?', [id]);
  if (!a) return res.status(404).json({ error: 'Nicht gefunden' });
  const [[me]] = await pool.execute('SELECT admin FROM users WHERE id=?', [req.uid]);
  if (!(me && me.admin) && a.user_id !== req.uid) return res.status(403).json({ error: 'Kein Zugriff' });
  res.json({ data_uri: a.data_uri });
}));

// ----- Nutzer: Meine Tickets -----
app.get('/my-tickets', auth, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT c.id, c.title, c.category, c.version, c.created_at, c.updated_at, l.slug listSlug, l.name listName,
       (SELECT COUNT(*) FROM board_comments bc WHERE bc.card_id=c.id AND bc.kind='comment') cc
     FROM board_cards c JOIN board_lists l ON l.id=c.list_id WHERE c.type='ticket' AND c.user_id=? ORDER BY c.updated_at DESC`, [req.uid]);
  res.json(rows.map(r => ({ id: r.id, title: r.title, category: r.category, catColor: r.category ? (BOARD_CAT_COLOR[r.category] || 'var(--mut)') : null, version: r.version, listSlug: r.listSlug, listName: r.listName, closed: r.listSlug === 'done', created_at: r.created_at, commentCount: Number(r.cc) })));
}));
app.get('/my-tickets/:id', auth, asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Ticket', 1, 4294967295);
  const [[c]] = await pool.execute("SELECT c.*, l.slug listSlug, l.name listName FROM board_cards c JOIN board_lists l ON l.id=c.list_id WHERE c.id=? AND c.type='ticket' AND c.user_id=?", [id, req.uid]);
  if (!c) return res.status(404).json({ error: 'Ticket nicht gefunden' });
  const [atts] = await pool.execute('SELECT id FROM board_attachments WHERE card_id=?', [id]);
  res.json({ ticket: { id: c.id, title: c.title, description: c.description || '', category: c.category, version: c.version, listSlug: c.listSlug, listName: c.listName, closed: c.listSlug === 'done', created_at: c.created_at }, feed: await loadCardFeed(id), attachments: atts.map(a => a.id) });
}));
app.post('/my-tickets/:id/comment', auth, rateLimitUser('ticketreply', 30), asyncRoute(async (req, res) => {
  const id = vInt(req.params.id, 'Ticket', 1, 4294967295);
  const text = vStr(req.body.text, 'Antwort', 4000);
  const [[c]] = await pool.execute("SELECT id FROM board_cards WHERE id=? AND type='ticket' AND user_id=?", [id, req.uid]);
  if (!c) return res.status(404).json({ error: 'Ticket nicht gefunden' });
  await pool.execute("INSERT INTO board_comments (card_id, user_id, kind, text) VALUES (?,?,'comment',?)", [id, req.uid, text]);
  await pool.execute('UPDATE board_cards SET updated_at=CURRENT_TIMESTAMP WHERE id=?', [id]);
  res.json({ ok: true });
}));

// ---------- NutriBot: Assistenz-Nachrichten ----------
async function botPost(uid, kind, ref, icon, color, title, text) {
  try {
    await pool.execute(
      'INSERT IGNORE INTO bot_messages (user_id, kind, ref, icon, color, title, text) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uid, kind, String(ref).slice(0, 80), icon, color, String(title).slice(0, 160), text ? String(text).slice(0, 500) : null]);
  } catch { /* dedupe/Fehler ignorieren, Bot ist best-effort */ }
}

// Tage bis zum nächsten Geburtstag + das Jahr dieses Geburtstags (für Geschenk-Status)
function bdayDaysServer(birthday, dn) {
  const parts = String(birthday).slice(0, 10).split('-');
  if (parts.length !== 3) return null;
  const mo = parseInt(parts[1]), da = parseInt(parts[2]);
  const todayMid = new Date(dn.getFullYear(), dn.getMonth(), dn.getDate());
  let next = new Date(dn.getFullYear(), mo - 1, da);
  if (next < todayMid) next = new Date(dn.getFullYear() + 1, mo - 1, da);
  return { days: Math.round((next - todayMid) / 86400000), year: next.getFullYear(), birthYear: /^\d{4}$/.test(parts[0]) ? parseInt(parts[0]) : null };
}

// Günstige, rein datenbasierte Trigger (keine KI): laufen beim Öffnen des Bots.
async function runBotChecks(uid) {
  const q = (sql) => pool.execute(sql, [uid]).then(([r]) => r);
  const dn = new Date();
  const today = dn.getFullYear() + '-' + String(dn.getMonth() + 1).padStart(2, '0') + '-' + String(dn.getDate()).padStart(2, '0');
  const ym = today.slice(0, 7);
  const [appts, goals, todos, bdays] = await Promise.all([
    q("SELECT id, title, `date`, `time` FROM appointments WHERE user_id = ? AND `date` >= CURDATE() AND `date` <= DATE_ADD(CURDATE(), INTERVAL 1 DAY)"),
    q('SELECT id, name, saved, target FROM goals WHERE user_id = ? AND target > 0 AND saved >= target'),
    q('SELECT COUNT(*) AS open FROM todos WHERE user_id = ? AND done = 0'),
    q('SELECT id, name, birthday, gift_idea, gift_year FROM people WHERE user_id = ? AND birthday IS NOT NULL'),
  ]);
  const used = await cloudUsage(uid), quota = await cloudQuota(uid);
  for (const a of appts) {
    const when = a.date === today ? 'heute' : 'morgen';
    await botPost(uid, 'appt', String(a.id), 'calendar-clock', '#60a5fa',
      `Termin ${when}: ${a.title}`, a.time ? `Um ${a.time} Uhr.` : 'Denk dran!');
  }
  for (const g of goals) {
    await botPost(uid, 'goal', String(g.id), 'party-popper', '#34d399',
      `Sparziel erreicht: ${g.name}`, `Du hast dein Ziel von ${Number(g.target).toFixed(0)} EUR geschafft. Stark!`);
  }
  for (const p of bdays) {
    const bi = bdayDaysServer(p.birthday, dn);
    if (!bi) continue;
    if (bi.days === 0) {
      const age = bi.birthYear ? (dn.getFullYear() - bi.birthYear) : null;
      await botPost(uid, 'bday', p.id + '-' + dn.getFullYear(), 'cake', '#f472b6',
        `${p.name} hat heute Geburtstag`, age && age > 0 && age < 130 ? `Wird heute ${age}. Denk an eine Gratulation!` : 'Denk an eine Gratulation!');
    } else if (bi.days >= 1 && bi.days <= 3) {
      const giftDone = p.gift_year != null && Number(p.gift_year) === bi.year;
      if (!giftDone) {
        await botPost(uid, 'gift', p.id + '-' + bi.year, 'gift', '#f472b6',
          `${p.name} hat in ${bi.days} ${bi.days === 1 ? 'Tag' : 'Tagen'} Geburtstag`,
          p.gift_idea ? `Geschenk schon besorgt? Deine Idee: ${p.gift_idea}` : 'Hast du schon ein Geschenk besorgt?');
      }
    }
  }
  if (todos[0].open >= 8) {
    await botPost(uid, 'todos', today, 'list-checks', '#fbbf24',
      `${todos[0].open} offene To-dos`, 'Deine To-do-Liste wird lang. Vielleicht ein paar heute abhaken?');
  }
  if (quota > 0 && used / quota >= 0.9) {
    await botPost(uid, 'cloud_full', ym, 'hard-drive', '#f87171',
      `Cloud fast voll (${Math.round(used / quota * 100)}%)`, 'Räum ein paar Dateien auf oder frag nach mehr Speicher.');
  }
}

app.get('/bot/messages', auth, asyncRoute(async (req, res) => {
  await runBotChecks(req.uid);
  const [rows] = await pool.execute(
    'SELECT id, kind, icon, color, title, text, is_read, created_at FROM bot_messages WHERE user_id = ? AND is_read = 0 ORDER BY id DESC LIMIT 40', [req.uid]);
  const [[c]] = await pool.execute('SELECT COUNT(*) AS unread FROM bot_messages WHERE user_id = ? AND is_read = 0', [req.uid]);
  res.json({ messages: rows, unread: c.unread });
}));

app.post('/bot/read', auth, asyncRoute(async (req, res) => {
  await pool.execute('UPDATE bot_messages SET is_read = 1 WHERE user_id = ? AND is_read = 0', [req.uid]);
  res.json({ ok: true });
}));

// Client-Benachrichtigung als NutriBot-Nachricht ablegen (dedupe ueber kind+ref via botPost).
app.post('/bot/push', auth, asyncRoute(async (req, res) => {
  const kind = vStr(req.body.kind, 'kind', 40);
  const ref = vStr(req.body.ref, 'ref', 80);
  const title = vStr(req.body.title, 'Titel', 160);
  const text = vStr(req.body.text, 'Text', 500, { optional: true }) || '';
  const icon = vStr(req.body.icon, 'icon', 40, { optional: true }) || 'bell';
  const color = vStr(req.body.color, 'color', 30, { optional: true }) || '#a78bfa';
  await botPost(req.uid, kind, ref, icon, color, title, text);
  res.json({ ok: true });
}));

// ---------- Eigene Rezepte (Nutzer) + oeffentlich teilbar ----------
// Naehrwerte serverseitig aus den Zutaten berechnen (food_id -> foods pro 100g).
async function computeUserRecipe(ings) {
  let kcal = 0, c = 0, p = 0, f = 0; const rows = [];
  for (const ing of (ings || []).slice(0, 50)) {
    const amount = Math.max(1, Math.min(100000, parseInt(ing.amount_g) || 0));
    const name = String(ing.name || 'Zutat').slice(0, 160);
    let k100 = Number(ing.k100) || 0, c100 = Number(ing.c100) || 0, p100 = Number(ing.p100) || 0, f100 = Number(ing.f100) || 0;
    const fid = parseInt(ing.food_id) || null;
    if (fid) { const [[fo]] = await pool.execute('SELECT kcal,carbs,protein,fat FROM foods WHERE id=?', [fid]); if (fo) { k100 = Number(fo.kcal) || 0; c100 = Number(fo.carbs) || 0; p100 = Number(fo.protein) || 0; f100 = Number(fo.fat) || 0; } }
    const ik = k100 * amount / 100, ic = c100 * amount / 100, ip = p100 * amount / 100, iff = f100 * amount / 100;
    kcal += ik; c += ic; p += ip; f += iff;
    rows.push([fid, name, amount, Math.round(ik), Math.round(ic), Math.round(ip), Math.round(iff)]);
  }
  return { kcal: Math.round(kcal), c: Math.round(c), p: Math.round(p), f: Math.round(f), rows };
}

app.get('/my-recipes', auth, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute('SELECT id,name,meal,time_min,kcal,carbs,protein,fat,is_public,created_at FROM user_recipes WHERE user_id=? ORDER BY id DESC', [req.uid]);
  res.json({ recipes: rows });
}));

app.get('/community/recipes', auth, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT r.id,r.name,r.meal,r.time_min,r.kcal,r.carbs,r.protein,r.fat,r.created_at,u.name AS author,u.id AS author_id FROM user_recipes r JOIN users u ON u.id=r.user_id WHERE r.is_public=1 ORDER BY r.id DESC LIMIT 100');
  res.json({ recipes: rows.map(r => ({ ...r, mine: r.author_id === req.uid })) });
}));

app.get('/my-recipes/:id', auth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [[r]] = await pool.execute('SELECT * FROM user_recipes WHERE id=? AND (user_id=? OR is_public=1)', [id, req.uid]);
  if (!r) return res.status(404).json({ error: 'Rezept nicht gefunden' });
  const [ings] = await pool.execute('SELECT food_id,name,amount_g,kcal,carbs,protein,fat FROM user_recipe_ingredients WHERE recipe_id=?', [id]);
  let steps = []; try { steps = JSON.parse(r.steps) || []; } catch (e) {}
  res.json({ recipe: { id: r.id, name: r.name, meal: r.meal, time_min: r.time_min, kcal: r.kcal, carbs: r.carbs, protein: r.protein, fat: r.fat, is_public: r.is_public, steps, ingredients: ings, mine: r.user_id === req.uid } });
}));

app.post('/my-recipes', auth, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const name = vStr(b.name, 'Name', 160);
  const meal = vEnum(b.meal, 'Mahlzeit', ['fruh', 'mittag', 'abend', 'snack'], { optional: true }) || 'mittag';
  const time_min = vInt(b.time_min, 'Zeit', 0, 1440, { optional: true }) || 0;
  const isPublic = vBool(b.is_public);
  const steps = Array.isArray(b.steps) ? b.steps.map(x => String(x).slice(0, 400)).filter(Boolean).slice(0, 20) : [];
  if (!Array.isArray(b.ingredients) || !b.ingredients.length) throw bad('Füge mindestens eine Zutat hinzu');
  const n = await computeUserRecipe(b.ingredients);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.execute('INSERT INTO user_recipes (user_id,name,meal,servings,time_min,kcal,carbs,protein,fat,steps,is_public) VALUES (?,?,?,1,?,?,?,?,?,?,?)',
      [req.uid, name, meal, time_min, n.kcal, n.c, n.p, n.f, JSON.stringify(steps), isPublic]);
    const rid = ins.insertId;
    for (const r of n.rows) await conn.execute('INSERT INTO user_recipe_ingredients (recipe_id,food_id,name,amount_g,kcal,carbs,protein,fat) VALUES (?,?,?,?,?,?,?,?)', [rid, ...r]);
    await conn.commit(); conn.release();
    logEvent('info', 'my_recipe', 'Eigenes Rezept angelegt: ' + name.slice(0, 60) + (isPublic ? ' (öffentlich)' : ''), { uid: req.uid, ip: req.ip });
    res.json({ ok: true, id: rid, kcal: n.kcal });
  } catch (e) { await conn.rollback(); conn.release(); throw e; }
}));

app.put('/my-recipes/:id/visibility', auth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const isPublic = vBool(req.body.is_public);
  const [r] = await pool.execute('UPDATE user_recipes SET is_public=? WHERE id=? AND user_id=?', [isPublic, id, req.uid]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Rezept nicht gefunden' });
  res.json({ ok: true, is_public: isPublic });
}));

app.delete('/my-recipes/:id', auth, asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.execute('DELETE FROM user_recipes WHERE id=? AND user_id=?', [id, req.uid]);
    await conn.execute('DELETE FROM user_recipe_ingredients WHERE recipe_id=?', [id]);
    await conn.commit(); conn.release();
    if (!r.affectedRows) return res.status(404).json({ error: 'Rezept nicht gefunden' });
    res.json({ ok: true });
  } catch (e) { await conn.rollback(); conn.release(); throw e; }
}));

// Produktsuche über Open Food Facts: Markenprodukte wie bei YAZIO (kein Key nötig)
app.get('/food/search', auth, rateLimitUser('food-search', 40), asyncRoute(async (req, res) => {
  const q = vStr(req.query.q, 'Suchbegriff', 80);
  // Lokale Produktdatenbank (Import aus Open Food Facts), Volltext-Prefix-Suche
  const tokens = q.toLowerCase().replace(/[+\-><()~*"@]/g, ' ').split(/\s+/).filter(w => w.length >= 3).slice(0, 6);
  if (!tokens.length) return res.json({ items: [] });
  const bool = tokens.map(w => '+' + w + '*').join(' ');
  let rows;
  try {
    [rows] = await pool.execute(
      'SELECT id, name, brand, kcal, carbs, protein, fat FROM foods WHERE MATCH(name, brand) AGAINST (? IN BOOLEAN MODE) LIMIT 40',
      [bool]);
  } catch (e) { rows = []; }
  const items = [];
  const seen = new Set();
  for (const r of rows) {
    const name = String(r.name || '').trim();
    if (!name) continue;
    const brand = r.brand ? String(r.brand).split(',')[0].trim() : '';
    const key = (brand + '|' + name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: r.id, name: name.slice(0, 120), brand: brand.slice(0, 60),
      kcal: Math.min(1000, r.kcal || 0), carbs: Math.round(r.carbs || 0), protein: Math.round(r.protein || 0), fat: Math.round(r.fat || 0),
      serving: null,
    });
    if (items.length >= 12) break;
  }
  res.json({ items });
}));

// Barcode-Nachschlag in der lokalen Produktdatenbank (Import aus Open Food Facts), für den Scanner
app.get('/food/barcode/:code', auth, rateLimitUser('food-search', 40), asyncRoute(async (req, res) => {
  const code = String(req.params.code || '').replace(/\D/g, '');
  if (code.length < 6 || code.length > 14) throw bad('Ungültiger Barcode');
  const [[p]] = await pool.execute('SELECT name, brand, kcal, carbs, protein, fat FROM foods WHERE barcode = ? LIMIT 1', [code]);
  if (!p) throw new HttpError(404, 'Produkt nicht gefunden');
  const name = String(p.name || 'Produkt').slice(0, 120);
  const brand = p.brand ? String(p.brand).split(',')[0].trim() : '';
  res.json({
    name: (brand && !name.toLowerCase().includes(brand.toLowerCase()) ? brand + ' ' : '') + name,
    kcal: p.kcal, carbs: Math.round(p.carbs || 0), protein: Math.round(p.protein || 0), fat: Math.round(p.fat || 0),
    per: '/100 g', serving: null,
  });
}));

// ---------- Health & Fehlerbehandlung ----------
app.get('/health', asyncRoute(async (req, res) => {
  await pool.execute('SELECT 1');
  res.json({ ok: true, service: 'nutridesk-api', version: require('./package.json').version });
}));

// ---------- Bot-Backend (Fake-KI, keine LLM): Chat, Tickets, Hilfecenter, TTS, Gedächtnis ----------
require('./bot')(app, { pool, auth, requireAdmin, asyncRoute, bad, HttpError, vStr, vInt, vNum, vDate, vEnum, vBool, rateLimitUser, reqIp, logEvent, botPost });

app.use((req, res) => res.status(404).json({ error: 'Route nicht gefunden' }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      console.error(new Date().toISOString(), req.method, req.url, '->', err.status, err.message);
      logEvent('error', 'error', req.method + ' ' + req.url + ': ' + err.message, { uid: req.uid, ip: req.ip });
    }
    return res.status(err.status).json({ error: err.message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültiges JSON' });
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Datei ist zu groß (max. 250 MB)' : 'Upload fehlgeschlagen' });
  }
  console.error(new Date().toISOString(), req.method, req.url, err);
  logEvent('error', 'error', req.method + ' ' + req.url + ': ' + (err && err.message ? err.message : 'Interner Fehler'), { uid: req.uid, ip: req.ip });
  res.status(500).json({ error: 'Interner Serverfehler' });
});

const BIND = process.env.BIND_ADDR || '127.0.0.1';
app.listen(PORT, BIND, () => console.log(`nutridesk-api läuft auf ${BIND}:${PORT} (systembasiert, keine KI)`));
