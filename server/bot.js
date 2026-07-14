// NutriDesk Bot-Backend (Fake-KI, KEIN LLM): Regel-Router + Wissenssuche + Aktionen + Tickets.
// Wird aus server.js per require('./bot')(app, deps) eingebunden. Alle Helfer kommen als deps rein.
'use strict';
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function registerBot(app, deps) {
  const {
    pool, auth, requireAdmin, asyncRoute, bad, HttpError,
    vStr, vInt, vNum, vDate, vEnum, vBool, rateLimitUser, reqIp, logEvent, botPost,
  } = deps;

  const WIKI_URL = process.env.WIKI_URL || 'http://127.0.0.1:35248';
  const NAMES = { man: 'Conrad', woman: 'Anja' };
  // Fuer die Sprachausgabe Abkuerzungen ausschreiben, damit sie nicht "g" oder "ml" buchstabiert (Anzeige bleibt kompakt).
  function spoken(text) {
    return String(text)
      .replace(/(\d)\s*kcal\b/gi, '$1 Kilokalorien').replace(/\bkcal\b/gi, 'Kilokalorien')
      .replace(/(\d)\s*mg\b/gi, '$1 Milligramm').replace(/(\d)\s*kg\b/gi, '$1 Kilogramm')
      .replace(/(\d)\s*ml\b/gi, '$1 Milliliter').replace(/(\d)\s*g\b/g, '$1 Gramm')
      .replace(/(\d)\s*km\/h\b/gi, '$1 Kilometer pro Stunde').replace(/\bEUR\b/g, 'Euro')
      .replace(/(\d)\s*%/g, '$1 Prozent');
  }
  // ElevenLabs (optional): Config-Datei /home/.elevenlabs.json = {"key":"...","man":"voiceId","woman":"voiceId","model":"eleven_turbo_v2_5"}.
  // Fehlt sie oder der Key, ist die Cloud-Sprachausgabe schlicht nicht verfuegbar (503) - KEIN Edge-Fallback.
  // Vorlesen laeuft dann rein lokal im Client (SEC-003B, speechSynthesis mit lokaler OS-Stimme).
  function elevenCfg() {
    try { return JSON.parse(fs.readFileSync(process.env.ELEVENLABS_FILE || '/home/.elevenlabs.json', 'utf8')); } catch (e) { return null; }
  }
  function elevenTTS(text, voiceKey) {
    return new Promise((resolve) => {
      const cfg = elevenCfg();
      if (!cfg || !cfg.key) return resolve(null);
      const voiceId = cfg[voiceKey] || cfg.woman || cfg.man;
      if (!voiceId) return resolve(null);
      const body = JSON.stringify({ text: String(text), model_id: cfg.model || 'eleven_turbo_v2_5', voice_settings: { stability: 0.5, similarity_boost: 0.8 } });
      const rq = https.request({ method: 'POST', hostname: 'api.elevenlabs.io', path: '/v1/text-to-speech/' + voiceId + '?output_format=mp3_44100_128', timeout: 15000, headers: { 'xi-api-key': cfg.key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
        if (r.statusCode !== 200) { r.resume(); return resolve(null); }
        const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => resolve(Buffer.concat(chunks)));
      });
      rq.on('timeout', () => rq.destroy()); rq.on('error', () => resolve(null));
      rq.write(body); rq.end();
    });
  }

  // ---------- SEC-003: zentrale TTS-Policy + Intent-Metadaten (serverseitig) ----------
  const ttsPolicy = require('./lib/tts-policy');
  const { ttsMetaFor } = require('./lib/tts-intents');
  const CLOUD_TTS_AVAILABLE = process.env.CLOUD_TTS_AVAILABLE === '1'; // globale Serversperre, Default AUS

  // ---------- kleine Helfer ----------
  const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function fmtEur(n) {
    let v = Math.round((Number(n) || 0) * 100) / 100; const neg = v < 0; v = Math.abs(v);
    const [i, dec] = v.toFixed(2).split('.');
    return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec + ' EUR';
  }
  // Deutsche Zahl aus Text ziehen ("12,50", "12.50", "12")
  function parseAmount(t) {
    const m = String(t).replace(/\./g, '').match(/(-?\d+(?:,\d+)?)/);
    if (!m) { const m2 = String(t).match(/(-?\d+(?:\.\d+)?)/); return m2 ? parseFloat(m2[1]) : null; }
    return parseFloat(m[1].replace(',', '.'));
  }
  function parseDateWord(t) {
    const s = String(t).toLowerCase().trim();
    const d = new Date();
    if (/\bheute\b/.test(s)) return todayStr();
    if (/\bmorgen\b/.test(s)) { d.setDate(d.getDate() + 1); }
    else if (/übermorgen/.test(s)) { d.setDate(d.getDate() + 2); }
    else {
      const m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/);
      if (m) { let y = m[3] ? parseInt(m[3]) : d.getFullYear(); if (y < 100) y += 2000; return y + '-' + String(parseInt(m[2])).padStart(2, '0') + '-' + String(parseInt(m[1])).padStart(2, '0'); }
      return null;
    }
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function parseTime(t) { const m = String(t).match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/); return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : null; }
  function httpGetJson(url, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https') ? https : http;
      const rq = lib.get(url, { timeout: timeoutMs }, (r) => {
        let data = ''; r.on('data', (c) => { data += c; if (data.length > 2_000_000) rq.destroy(); });
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON')); } });
      });
      rq.on('timeout', () => rq.destroy(new Error('Timeout')));
      rq.on('error', reject);
    });
  }

  // ---------- Sitzung + Verlauf ----------
  async function ensureSession(uid, sid, share) {
    // SEC-BOT-SESSION: Eine vom Client gelieferte session_id wird NUR uebernommen, wenn sie gueltig ist UND
    // dem anfragenden Nutzer gehoert. Eine fremde (oder kollidierende) ID wird NICHT angefasst - sonst koennte
    // ein Nutzer per Upsert das shared-Flag der Session eines anderen kippen (-> Offenlegung an Admins).
    // Sonst wird eine neue serverseitige ID mit hoher Entropie (128 Bit) erzeugt.
    if (sid && /^[A-Za-z0-9_-]{8,40}$/.test(sid)) {
      const [[own]] = await pool.execute('SELECT user_id FROM bot_sessions WHERE session_id=?', [sid]);
      if (own && Number(own.user_id) !== Number(uid)) sid = null; // gehoert einem anderen Nutzer -> nicht anfassen
    } else { sid = null; }
    if (!sid) sid = 'ki' + crypto.randomBytes(16).toString('hex');
    await pool.execute(
      'INSERT INTO bot_sessions (session_id, user_id, shared) VALUES (?,?,?) ON DUPLICATE KEY UPDATE last_at=CURRENT_TIMESTAMP, shared=VALUES(shared)',
      [sid, uid, share ? 1 : 0]);
    return sid;
  }
  async function saveChat(sid, uid, role, text, intent, ttsMeta) {
    let insertId = null;
    const r = await pool.execute('INSERT INTO bot_chat (session_id, user_id, role, text, intent, tts_meta) VALUES (?,?,?,?,?,?)',
      [sid, uid, role, String(text).slice(0, 6000), intent || null, ttsMeta ? JSON.stringify(ttsMeta) : null]).catch(() => null);
    if (r && r[0] && r[0].insertId) insertId = r[0].insertId;
    await pool.execute('UPDATE bot_sessions SET msg_count=msg_count+1, last_at=CURRENT_TIMESTAMP WHERE session_id=?', [sid]).catch(() => {});
    return insertId;
  }

  // Regelbasierte Fakten-Erkennung (kein LLM): merkt sich einfache Aussagen ueber den Nutzer.
  async function scanMemory(uid, text) {
    const t = String(text).toLowerCase();
    const save = (k, v) => pool.execute(
      'INSERT INTO bot_user_memory (user_id, mkey, mval) VALUES (?,?,?) ON DUPLICATE KEY UPDATE mval=VALUES(mval), updated_at=CURRENT_TIMESTAMP',
      [uid, k, String(v).slice(0, 200)]).catch(() => {});
    let m;
    if (/\b(vegan|veganer|veganerin)\b/.test(t)) save('Ernährung', 'vegan');
    else if (/\b(vegetarisch|vegetarier|vegetarierin)\b/.test(t) || /ich esse kein fleisch/.test(t)) save('Ernährung', 'vegetarisch');
    if ((m = text.match(/ich hei(?:ß|ss)e\s+([A-Za-zÄÖÜäöüß]{2,30})/i)) || (m = text.match(/mein name ist\s+([A-Za-zÄÖÜäöüß]{2,30})/i))) save('Name', m[1]);
    if ((m = t.match(/(?:ziel|abnehmen|zunehmen|halten)[^.]{0,24}?(\d{3,5})\s*(?:kcal|kalorien)/))) save('Kalorien-Ziel', m[1] + ' kcal');
    if ((m = text.match(/ich (?:mag kein|mag keine|vertrage kein|vertrage keine|esse kein|esse keine)\s+([A-Za-zÄÖÜäöüß ]{3,30})/i))) save('Mag nicht', m[1].trim());
    if ((m = text.match(/ich (?:wohne|lebe) in\s+([A-Za-zÄÖÜäöüß .-]{2,40})/i))) save('Wohnort', m[1].trim());
    if ((m = text.match(/ich spare (?:auf|für)\s+(?:ein |eine |einen )?([A-Za-zÄÖÜäöüß ]{3,40})/i))) save('Sparziel', m[1].trim());
  }

  // ---------- laufende Aktions-Flows (im RAM; nach Neustart weg, unkritisch) ----------
  const flows = new Map(); // key uid:sid -> { type, step, data, awaitConfirm }
  const fkey = (uid, sid) => uid + ':' + sid;

  // ---------- Ton ----------
  function applyTone(text, tone) {
    if (tone === 'locker') return text;
    if (tone === 'coach') return text;
    return text; // neutral
  }

  // ---------- Nutzer-Einstellungen ----------
  async function getSettings(uid) {
    const [[s]] = await pool.execute(
      'SELECT assistant, bot_tone, share_chats, allow_location, home_city, home_lat, home_lon, cloud_tts_enabled, cloud_tts_provider, cloud_tts_privacy_version FROM user_settings WHERE user_id=?', [uid]);
    return s || {};
  }

  // ---------- Wissenssuche (Hilfe-Beiträge, Volltext) ----------
  async function searchHelp(q) {
    const clean = String(q).replace(/[+\-<>~*()"@]/g, ' ').trim();
    if (clean.length < 2) return [];
    try {
      const [rows] = await pool.execute(
        'SELECT id,slug,title,body,keywords, MATCH(title,body,keywords) AGAINST (? IN NATURAL LANGUAGE MODE) AS score ' +
        'FROM help_articles WHERE MATCH(title,body,keywords) AGAINST (? IN NATURAL LANGUAGE MODE) ORDER BY score DESC LIMIT 3',
        [clean, clean]);
      return rows.filter(r => r.score > 0);
    } catch (e) { return []; }
  }

  // ---------- Nährwert-Suche (mehrere Kandidaten) ----------
  async function foodCandidates(q, limit = 6) {
    const toks = String(q).toLowerCase().split(/[^a-z0-9äöüß]+/i).filter(t => t.length >= 3);
    let rows = [];
    if (toks.length) {
      const bool = toks.map(t => '+' + t + '*').join(' ');
      [rows] = await pool.execute(
        'SELECT name, brand, kcal, carbs, protein, fat FROM foods WHERE MATCH(name, brand) AGAINST (? IN BOOLEAN MODE) ' +
        'ORDER BY (name LIKE ?) DESC, (kcal BETWEEN 20 AND 900) DESC, (kcal>0) DESC, LENGTH(name) ASC LIMIT ?',
        [bool, toks[0] + '%', limit]);
    }
    if (!rows.length) {
      [rows] = await pool.execute(
        'SELECT name, brand, kcal, carbs, protein, fat FROM foods WHERE name LIKE ? ORDER BY (name LIKE ?) DESC, (kcal>0) DESC, LENGTH(name) ASC LIMIT ?',
        ['%' + q + '%', q + '%', limit]);
    }
    return rows.map(f => ({
      name: String(f.name || '').slice(0, 120), brand: f.brand ? String(f.brand).slice(0, 60) : '',
      kcal: Math.max(0, Math.round(f.kcal) || 0), carbs: Math.round(f.carbs) || 0, protein: Math.round(f.protein) || 0, fat: Math.round(f.fat) || 0,
    }));
  }

  // ---------- Wikilite (Allgemeinwissen) ----------
  async function wikiSearch(q) {
    // Echter wikilite-Contract: Param heißt "query". Reihenfolge: Titel (präzise) -> lexical (schnell) -> semantic (~4s).
    // Frage-Wörter entfernen, damit "Wer war Angela Merkel" auf den Artikel "Angela Merkel" zielt.
    const clean = String(q)
      .replace(/^(wer|was|wie|wann|wo|warum|wieso|welche[rns]?)\s+(ist|war|sind|waren|viele?|heißt|bedeutet|macht|kann)\s+/i, '')
      .replace(/\b(eigentlich|genau|denn|mir|mal|bitte|erkläre?|erklär|sag)\b/gi, '')
      .replace(/[?.!]/g, '').trim();
    const term = clean.length >= 2 ? clean : String(q);
    const enc = encodeURIComponent(term);
    for (const ep of ['title', 'lexical', 'semantic']) {
      try {
        const j = await httpGetJson(`${WIKI_URL}/api/search/${ep}?query=${enc}&limit=3`, ep === 'semantic' ? 12000 : 4000);
        const arr = j && j.results;
        if (arr && arr.length) {
          const top = arr[0];
          let text = String(top.text || '').replace(/<[^>]+>/g, '');
          // Vollen Intro-Absatz aus dem Artikel holen (schöner als der kurze Snippet)
          try {
            const a = await httpGetJson(`${WIKI_URL}/api/article?id=${top.article_id}`, 4000);
            const secs = a && a.article && a.article.sections;
            if (secs && secs.length && secs[0].content) text = String(secs[0].content);
          } catch (e) { /* Snippet reicht */ }
          return { title: top.title || 'Wikipedia', text: text.replace(/\s+/g, ' ').trim().slice(0, 700) };
        }
      } catch (e) { /* nächste Suchart */ }
    }
    return null;
  }

  // ---------- Wetter (Open-Meteo, gratis, kein Key) ----------
  async function weatherFor(lat, lon, city) {
    const j = await httpGetJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`, 5000);
    if (!j || !j.current) return null;
    const WC = { 0: 'klar', 1: 'überwiegend klar', 2: 'teils bewölkt', 3: 'bewölkt', 45: 'neblig', 48: 'neblig', 51: 'leichter Niesel', 61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen', 71: 'leichter Schnee', 73: 'Schnee', 80: 'Schauer', 95: 'Gewitter' };
    return { city: city || '', temp: Math.round(j.current.temperature_2m), desc: WC[j.current.weather_code] || 'wechselhaft', wind: Math.round(j.current.wind_speed_10m) };
  }
  async function geocode(city) {
    try { const j = await httpGetJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=de`, 5000); const r = j && j.results && j.results[0]; return r ? { lat: r.latitude, lon: r.longitude, city: r.name } : null; } catch (e) { return null; }
  }

  // ---------- eigene Daten (lesen) ----------
  async function dataAnswer(uid, kind) {
    if (kind === 'kcal_today') {
      const [[r]] = await pool.execute('SELECT COALESCE(SUM(kcal),0) k, COALESCE(SUM(protein),0) p FROM food_log WHERE user_id=? AND date=CURDATE()', [uid]);
      return `Heute hast du bisher ${Math.round(r.k)} kcal und ${Math.round(r.p)} g Eiweiß eingetragen.`;
    }
    if (kind === 'kcal_week') {
      const [[r]] = await pool.execute('SELECT ROUND(AVG(dk)) a FROM (SELECT SUM(kcal) dk FROM food_log WHERE user_id=? AND date>=DATE_SUB(CURDATE(),INTERVAL 7 DAY) GROUP BY date) t', [uid]);
      return r.a ? `Dein Schnitt der letzten 7 Tage liegt bei rund ${r.a} kcal pro Tag.` : 'Für die letzten 7 Tage habe ich noch keine Einträge.';
    }
    if (kind === 'weight') {
      const [rows] = await pool.execute('SELECT date, kg FROM weights WHERE user_id=? ORDER BY date DESC LIMIT 2', [uid]);
      if (!rows.length) return 'Du hast noch kein Gewicht eingetragen.';
      let s = `Dein letztes Gewicht: ${Number(rows[0].kg).toFixed(1)} kg (${rows[0].date}).`;
      if (rows[1]) { const d = rows[0].kg - rows[1].kg; s += d === 0 ? ' Unverändert zum Eintrag davor.' : ` Das sind ${d > 0 ? '+' : ''}${d.toFixed(1)} kg zum Eintrag davor.`; }
      return s;
    }
    if (kind === 'balance') {
      const [[r]] = await pool.execute('SELECT COALESCE(SUM(amount),0) bal FROM transactions WHERE user_id=? AND planned=0', [uid]);
      const [[m]] = await pool.execute("SELECT COALESCE(SUM(GREATEST(-amount,0)),0) aus FROM transactions WHERE user_id=? AND planned=0 AND amount<0 AND date>=DATE_FORMAT(CURDATE(),'%Y-%m-01')", [uid]);
      return `Dein aktueller Saldo im Finanzbuch: ${fmtEur(r.bal)}. Diesen Monat ausgegeben: ${fmtEur(m.aus)}.`;
    }
    if (kind === 'todos') {
      const [[r]] = await pool.execute('SELECT COUNT(*) n FROM todos WHERE user_id=? AND done=0', [uid]);
      return r.n ? `Du hast ${r.n} offene ${r.n === 1 ? 'Aufgabe' : 'Aufgaben'}.` : 'Du hast keine offenen Aufgaben, sauber!';
    }
    if (kind === 'appts') {
      const [rows] = await pool.execute("SELECT title, date, time FROM appointments WHERE user_id=? AND date>=CURDATE() ORDER BY date, time LIMIT 3", [uid]);
      if (!rows.length) return 'In nächster Zeit stehen keine Termine an.';
      return 'Deine nächsten Termine:\n' + rows.map(a => `- ${a.date}${a.time ? ' ' + a.time : ''}: ${a.title}`).join('\n');
    }
    return null;
  }

  // ---------- Aktions-Flows starten ----------
  function startFlow(uid, sid, type, seed) {
    const f = { type, step: 0, data: seed || {}, awaitConfirm: false };
    flows.set(fkey(uid, sid), f);
    return f;
  }
  const FLOW_DEFS = {
    transaction: {
      title: 'Buchung',
      slots: [
        { key: 'direction', ask: 'Ist das eine Ausgabe oder eine Einnahme?', parse: (t) => /einnahm|eingang|gehalt|lohn|erhalten|bekommen|\+/.test(t.toLowerCase()) ? 'einnahme' : (/ausgab|ausgeben|bezahlt|gekauft|kostet|-/.test(t.toLowerCase()) ? 'ausgabe' : null) },
        { key: 'amount', ask: 'Wie hoch ist der Betrag in Euro?', parse: (t) => { const n = parseAmount(t); return n != null && n > 0 ? n : null; } },
        { key: 'name', ask: 'Wofür bzw. von wem? (kurze Bezeichnung)', parse: (t) => t.trim().slice(0, 120) || null },
      ],
    },
    todo: { title: 'Aufgabe', slots: [{ key: 'text', ask: 'Wie lautet die Aufgabe?', parse: (t) => t.trim().slice(0, 300) || null }] },
    weight: { title: 'Gewicht', slots: [{ key: 'kg', ask: 'Welches Gewicht in kg soll ich eintragen?', parse: (t) => { const n = parseAmount(t); return n != null && n >= 20 && n <= 400 ? n : null; } }] },
    appointment: {
      title: 'Termin',
      slots: [
        { key: 'title', ask: 'Wie heißt der Termin?', parse: (t) => t.trim().slice(0, 120) || null },
        { key: 'date', ask: 'An welchem Tag? (z.B. heute, morgen oder 24.12.)', parse: (t) => parseDateWord(t) },
        { key: 'time', ask: 'Um wie viel Uhr? (HH:MM, oder "egal")', parse: (t) => /egal|keine|ohne/.test(t.toLowerCase()) ? '' : (parseTime(t) || null) },
      ],
    },
    food: {
      title: 'Essen',
      slots: [
        { key: 'name', ask: 'Was hast du gegessen?', parse: (t) => t.trim().slice(0, 120) || null },
        { key: 'grams', ask: 'Wie viel Gramm ungefähr? (Zahl, oder sag klein, normal oder groß)', parse: (t) => { const s = String(t).toLowerCase(); if (/\bklein|wenig/.test(s)) return 30; if (/normal|mittel|standard|durchschnitt|portion|wei(ß|ss) nicht|keine ahnung|egal/.test(s)) return 60; if (/gro(ß|ss)|viel/.test(s)) return 120; const n = parseAmount(t); return n != null && n > 0 && n <= 5000 ? Math.round(n) : null; } },
        { key: 'meal', ask: 'Zu welcher Mahlzeit? (Frühstück, Mittag, Abend oder Snack)', parse: (t) => { const s = t.toLowerCase(); if (/früh|fruh|morgen/.test(s)) return 'fruh'; if (/mittag/.test(s)) return 'mittag'; if (/abend/.test(s)) return 'abend'; if (/snack|zwischen/.test(s)) return 'snack'; return null; } },
      ],
    },
    ticket: {
      title: 'Support-Ticket',
      slots: [
        { key: 'subject', ask: 'Worum geht es? (kurzer Betreff)', parse: (t) => t.trim().slice(0, 200) || null },
        { key: 'description', ask: 'Beschreib bitte kurz das Problem oder Anliegen.', parse: (t) => t.trim().slice(0, 4000) || null },
      ],
    },
  };

  async function confirmSummary(uid, f) {
    const d = f.data;
    if (f.type === 'transaction') return `${d.direction === 'einnahme' ? 'Einnahme' : 'Ausgabe'} über ${fmtEur(d.amount)} (${d.name}) für heute. Soll ich das ins Finanzbuch eintragen?`;
    if (f.type === 'todo') return `Aufgabe "${d.text}" anlegen. Soll ich das machen?`;
    if (f.type === 'weight') return `Gewicht ${Number(d.kg).toFixed(1)} kg für heute speichern. Eintragen?`;
    if (f.type === 'appointment') return `Termin "${d.title}" am ${d.date}${d.time ? ' um ' + d.time : ''}. Soll ich ihn anlegen?`;
    if (f.type === 'food') {
      const cand = (await foodCandidates(d.name, 1))[0];
      if (cand) { d._kcal = Math.round(cand.kcal * d.grams / 100); d._c = Math.round(cand.carbs * d.grams / 100); d._p = Math.round(cand.protein * d.grams / 100); d._f = Math.round(cand.fat * d.grams / 100); d._match = cand.name; }
      else { d._kcal = 0; d._c = 0; d._p = 0; d._f = 0; d._match = d.name; }
      return `${d.grams} g ${d._match}: ca. ${d._kcal} kcal. Als ${({ fruh: 'Frühstück', mittag: 'Mittag', abend: 'Abend', snack: 'Snack' })[d.meal]} eintragen?`;
    }
    if (f.type === 'ticket') return `Ich lege ein Ticket an: "${d.subject}". Der Support meldet sich bei dir. Abschicken?`;
    return 'Soll ich das so ausführen?';
  }

  async function executeFlow(uid, f) {
    const d = f.data;
    if (f.type === 'transaction') {
      const amount = d.direction === 'einnahme' ? Math.abs(d.amount) : -Math.abs(d.amount);
      await pool.execute('INSERT INTO transactions (user_id, date, name, category, amount, planned) VALUES (?,?,?,?,?,0)', [uid, todayStr(), d.name, 'Sonstiges', amount]);
      return `Erledigt. ${d.direction === 'einnahme' ? 'Einnahme' : 'Ausgabe'} über ${fmtEur(Math.abs(d.amount))} ist im Finanzbuch.`;
    }
    if (f.type === 'todo') { await pool.execute('INSERT INTO todos (user_id, text, done) VALUES (?,?,0)', [uid, d.text]); return `Aufgabe "${d.text}" ist angelegt.`; }
    if (f.type === 'weight') { await pool.execute('INSERT INTO weights (user_id, date, kg) VALUES (?,?,?) ON DUPLICATE KEY UPDATE kg=VALUES(kg)', [uid, todayStr(), d.kg]).catch(async () => { await pool.execute('INSERT INTO weights (user_id, date, kg) VALUES (?,?,?)', [uid, todayStr(), d.kg]); }); return `Gewicht ${Number(d.kg).toFixed(1)} kg gespeichert.`; }
    if (f.type === 'appointment') { await pool.execute('INSERT INTO appointments (user_id, title, date, time) VALUES (?,?,?,?)', [uid, d.title, d.date, d.time || null]); return `Termin "${d.title}" am ${d.date}${d.time ? ' um ' + d.time : ''} ist eingetragen.`; }
    if (f.type === 'food') { await pool.execute('INSERT INTO food_log (user_id, date, meal, name, kcal, carbs, protein, fat) VALUES (?,?,?,?,?,?,?,?)', [uid, todayStr(), d.meal, d._match.slice(0, 120), d._kcal, d._c, d._p, d._f]); return `Eingetragen: ${d.grams} g ${d._match} mit ${d._kcal} kcal.`; }
    if (f.type === 'ticket') {
      const [r] = await pool.execute('INSERT INTO tickets (user_id, subject, category) VALUES (?,?,?)', [uid, d.subject, 'bot']);
      await pool.execute('INSERT INTO ticket_messages (ticket_id, sender, text) VALUES (?,?,?)', [r.insertId, 'user', d.description]);
      logEvent('info', 'bot_ticket', d.subject.slice(0, 80), { uid });
      return `Dein Ticket ist erstellt (Nr. ${r.insertId}). Du findest es unter "Meine Tickets", der Support meldet sich.`;
    }
    return 'Erledigt.';
  }

  // ---------- Intent-Router ----------
  async function route(uid, sid, text, settings) {
    const t = text.trim();
    const low = t.toLowerCase();
    const key = fkey(uid, sid);
    let flow = flows.get(key);

    // Abbruch jederzeit
    if (flow && /^(abbrechen|abbruch|stop|vergiss es|doch nicht|nein danke)$/.test(low)) { flows.delete(key); return { intent: 'cancel', reply: 'Alles klar, abgebrochen.' }; }

    // Laufender Flow
    if (flow) {
      if (flow.awaitConfirm) {
        if (/^(ja|jup|jo|klar|mach|passt|ok|okay|gerne|bestätigen|erledige|ja bitte)/.test(low)) {
          flows.delete(key);
          const reply = await executeFlow(uid, flow);
          return { intent: 'action_done:' + flow.type, reply };
        }
        if (/^(nein|ne|nö|abbrechen|doch nicht)/.test(low)) { flows.delete(key); return { intent: 'cancel', reply: 'Okay, ich habe nichts eingetragen.' }; }
        return { intent: 'confirm', reply: 'Sag "ja" zum Eintragen oder "abbrechen".', quicks: [{ label: 'Ja', send: 'ja' }, { label: 'Abbrechen', send: 'abbrechen' }] };
      }
      const def = FLOW_DEFS[flow.type];
      const slot = def.slots[flow.step];
      const val = slot.parse(t);
      if (val === null) return { intent: 'flow', reply: 'Das habe ich nicht verstanden. ' + slot.ask };
      flow.data[slot.key] = val;
      flow.step++;
      if (flow.step < def.slots.length) return { intent: 'flow', reply: def.slots[flow.step].ask };
      flow.awaitConfirm = true;
      return { intent: 'flow_confirm', reply: await confirmSummary(uid, flow), quicks: [{ label: 'Ja, machen', send: 'ja' }, { label: 'Abbrechen', send: 'abbrechen' }] };
    }

    // Smalltalk ZUERST, damit Plauderei nicht in die Wikipedia-Suche abrutscht.
    if (/wie (geht|gehts|geht's|läuft)|alles (gut|klar) bei dir|wie ist dein tag|was geht\b/.test(low)) {
      return { intent: 'smalltalk', reply: 'Mir geht es gut, danke der Nachfrage. Und dir? Ich bin bereit, wenn du etwas brauchst: App-Hilfe, Nährwerte, deine Zahlen oder etwas eintragen.' };
    }
    if (/wer bist du|wie hei(ß|ss)t du|was bist du|stell dich vor|erzähl.*über dich/.test(low)) {
      return { intent: 'smalltalk', reply: `Ich bin ${NAMES[settings.assistant === 'man' ? 'man' : 'woman']}, dein Assistent in NutriDesk. Ich helfe dir bei der App, bei Nährwerten und deinen Finanzen, kann dir etwas nachschlagen und Dinge für dich eintragen.` };
    }
    if (/was kannst du|was machst du|wobei (kannst|hilfst) du|womit kannst du helfen|wie kannst du helfen/.test(low)) {
      return { intent: 'smalltalk', reply: 'Ich kann dir bei der App helfen, Nährwerte nachschlagen, deine Kalorien, Finanzen und Termine zeigen und Sachen für dich eintragen (Buchung, Essen, Termin, Todo, Gewicht). Frag einfach los.', quicks: [{ label: 'Kalorien heute', send: 'Wie viele Kalorien habe ich heute?' }, { label: 'Ausgabe eintragen', send: 'Ich möchte eine Ausgabe eintragen' }] };
    }
    if (/^(danke|dankeschön|vielen dank|merci|thx|thanks|passt|perfekt|super|top|cool|nice)\b/.test(low)) {
      return { intent: 'smalltalk', reply: 'Gern! Wenn du noch etwas brauchst, sag einfach Bescheid.' };
    }
    if (/^(tschüss|tschüs|ciao|bye|bis später|bis dann|gute nacht|man sieht sich)\b/.test(low)) {
      return { intent: 'smalltalk', reply: 'Bis später. Ich bin da, wenn du mich brauchst.' };
    }
    if (/hab dich lieb|ich mag dich|bist (süß|nett|toll|cool|lieb)|ich liebe dich/.test(low)) {
      return { intent: 'smalltalk', reply: 'Das ist lieb, danke. Ich helfe dir gern weiter, was brauchst du?' };
    }
    if (/\bwitz|witze|scherz|mach mich lachen|erzähl.*witz/.test(low)) {
      return { intent: 'smalltalk', reply: 'Witze sind ehrlich gesagt nicht meine Stärke. Ich bin eher für App-Hilfe, Ernährung und Finanzen da, frag mich ruhig etwas dazu.' };
    }
    // Begrüßung
    if (/^(hi+|hallo|hey+|moin|servus|grü(ß|ss)|guten (morgen|tag|abend)|na\b|yo\b|hallöchen)/.test(low)) {
      return { intent: 'greet', reply: `Hallo! Ich bin ${NAMES[settings.assistant === 'man' ? 'man' : 'woman']}. Ich helfe dir bei der App, bei Nährwerten, deinen Daten und kann Sachen für dich eintragen. Was brauchst du?`, quicks: [{ label: 'Kalorien heute', send: 'Wie viele Kalorien habe ich heute?' }, { label: 'Ausgabe eintragen', send: 'Ich möchte eine Ausgabe eintragen' }, { label: 'Hilfe', send: 'Wie funktioniert der Ernährungsplan?' }] };
    }

    // Aktionen (Eintragen/Erledigen)
    if (/(trag|eintragen|buch|erfass|notier|leg an|anlegen|hinzufüg)/.test(low) || /(ausgabe|einnahme)/.test(low)) {
      if (/gewicht|wiege|gewogen|kg\b/.test(low)) { startFlow(uid, sid, 'weight'); const n = parseAmount(low); if (n && n >= 20 && n <= 400) { const f = flows.get(key); f.data.kg = n; f.step = 1; f.awaitConfirm = true; return { intent: 'flow', reply: await confirmSummary(uid, f), quicks: [{ label: 'Ja', send: 'ja' }, { label: 'Abbrechen', send: 'abbrechen' }] }; } return { intent: 'flow', reply: FLOW_DEFS.weight.slots[0].ask }; }
      if (/aufgabe|todo|to-do|erledig/.test(low)) { startFlow(uid, sid, 'todo'); return { intent: 'flow', reply: FLOW_DEFS.todo.slots[0].ask }; }
      if (/termin|appointment|kalender/.test(low)) { startFlow(uid, sid, 'appointment'); return { intent: 'flow', reply: FLOW_DEFS.appointment.slots[0].ask }; }
      if (/gegessen|essen|kalorien.*(trag|eintr)|mahlzeit|food/.test(low)) { startFlow(uid, sid, 'food'); return { intent: 'flow', reply: FLOW_DEFS.food.slots[0].ask }; }
      // Standard: Finanz-Buchung
      const f = startFlow(uid, sid, 'transaction');
      if (/einnahme|gehalt|lohn|erhalten|bekommen/.test(low)) f.data.direction = 'einnahme';
      else if (/ausgabe|bezahlt|gekauft|gekostet/.test(low)) f.data.direction = 'ausgabe';
      const amt = parseAmount(low.replace(/\b(19|20)\d{2}\b/g, ''));
      if (amt && amt > 0) f.data.amount = amt;
      // ersten offenen Slot finden
      const def = FLOW_DEFS.transaction;
      while (f.step < def.slots.length && f.data[def.slots[f.step].key] != null) f.step++;
      if (f.step >= def.slots.length) { f.awaitConfirm = true; return { intent: 'flow', reply: await confirmSummary(uid, f), quicks: [{ label: 'Ja', send: 'ja' }, { label: 'Abbrechen', send: 'abbrechen' }] }; }
      return { intent: 'flow', reply: def.slots[f.step].ask };
    }

    // Eigene Daten (lesen)
    if (/(wie viele?|wieviel).*(kalorien|kcal).*(heute|bisher)|kalorien heute|kcal heute/.test(low)) return { intent: 'data', reply: await dataAnswer(uid, 'kcal_today') };
    if (/(kalorien|kcal).*(woche|schnitt|durchschnitt)/.test(low)) return { intent: 'data', reply: await dataAnswer(uid, 'kcal_week') };
    if (/(mein|aktuelles?)\s*gewicht|wie schwer|wie viel wiege/.test(low)) return { intent: 'data', reply: await dataAnswer(uid, 'weight') };
    if (/kontostand|saldo|wie viel geld|finanzen|ausgegeben diesen monat|budget übrig/.test(low)) return { intent: 'data', reply: await dataAnswer(uid, 'balance') };
    if (/offene (aufgaben|todos|to-dos)|wie viele (aufgaben|todos)/.test(low)) return { intent: 'data', reply: await dataAnswer(uid, 'todos') };
    if (/(nächste[rn]?|welche) termine?|was steht an|termine/.test(low)) return { intent: 'data', reply: await dataAnswer(uid, 'appts') };

    // Wetter (Open-Meteo). Explizit genannte Stadt geht immer; eigener Standort nur mit Datenschutz-Schalter.
    if (/wetter|temperatur|regnet|wie warm|grad draußen/.test(low)) {
      let lat = null, lon = null, city = null;
      const cm = t.match(/in\s+([A-Za-zÄÖÜäöüß .-]{2,40})/);
      if (cm) { const g = await geocode(cm[1].trim()); if (g) { lat = g.lat; lon = g.lon; city = g.city; } }
      if (lat == null && settings.allow_location && settings.home_lat != null) { lat = settings.home_lat; lon = settings.home_lon; city = settings.home_city; }
      if (lat == null) return { intent: 'weather', reply: settings.allow_location ? 'Ich habe noch keinen Standort hinterlegt. Nenn mir eine Stadt, z.B. "Wetter in Köln".' : 'Nenn mir eine Stadt (z.B. "Wetter in Berlin"), oder aktivier deinen Standort in den Einstellungen unter Datenschutz.' };
      const w = await weatherFor(lat, lon, city).catch(() => null);
      return { intent: 'weather', reply: w ? `In ${w.city || 'deiner Region'} sind es gerade ${w.temp} Grad, ${w.desc}, Wind ${w.wind} km/h.` : 'Das Wetter konnte ich gerade nicht abrufen.' };
    }

    // Nährwert-Frage ("wie viel kcal hat nutella")
    if (/(wie viele?|wieviel).*(kalorien|kcal|eiweiß|protein|fett|kohlenhydrate)/.test(low) || /(kalorien|kcal|nährwerte?)\s+(von|für|hat)/.test(low)) {
      const m = low.replace(/.*(hat|von|für|in)\s+/,'').replace(/[?.!]/g,'').trim() || low.replace(/(wie viele?|wieviel|kalorien|kcal|hat|eine[nr]?|ein|der|die|das)/g,' ').trim();
      const cands = await foodCandidates(m, 6);
      if (!cands.length) return { intent: 'food_info', reply: 'Dazu habe ich in der Lebensmittel-Datenbank nichts gefunden. Formulier es vielleicht anders.' };
      const top = cands[0];
      const others = cands.slice(1, 5).filter(c => c.name.toLowerCase() !== top.name.toLowerCase());
      return {
        intent: 'food_info',
        reply: `${top.name}${top.brand ? ' (' + top.brand + ')' : ''}: ${top.kcal} kcal pro 100 g, ${top.protein} g Eiweiß, ${top.carbs} g Kohlenhydrate, ${top.fat} g Fett.`,
        quicks: others.map(c => ({ label: c.name.slice(0, 28), send: 'Wie viele kalorien hat ' + c.name })).concat([{ label: 'Ins Tagebuch', send: 'Ich möchte ' + top.name + ' eintragen' }]),
        sources: [{ kind: 'food', label: 'Lebensmittel-Datenbank' }],
      };
    }

    // Hilfe / Wissen. App-Hilfe nur, wenn der Treffer inhaltlich zur Frage passt (teilt ein Wort in Titel/Keywords),
    // sonst rutscht z.B. "Wer war Angela Merkel" faelschlich in einen Hilfe-Artikel (Score allein reicht nicht).
    const fold = (x) => String(x).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
    const STOPW = new Set(['eine', 'einen', 'einer', 'einem', 'mein', 'meine', 'meinen', 'wie', 'was', 'wer', 'war', 'sind', 'wird', 'warum', 'wieso', 'welche', 'kann', 'ich', 'den', 'der', 'die', 'das', 'fuer', 'ueber', 'mich', 'dich', 'ist', 'und', 'oder', 'sich', 'man', 'wann', 'habe', 'gibt']);
    const qWords = (fold(t).match(/[a-z0-9]{4,}/g) || []).filter((w) => !STOPW.has(w));
    const helpRelevant = (a) => { const at = fold((a.title || '') + ' ' + (a.keywords || '') + ' ' + (a.slug || '')).match(/[a-z0-9]{4,}/g) || []; return qWords.some((w) => at.indexOf(w) >= 0); };
    const help = await searchHelp(t);
    const helpTop = (help.length && help[0].score >= 1 && helpRelevant(help[0])) ? help[0] : null;
    if (helpTop) {
      const body = String(helpTop.body).replace(/\s+/g, ' ').slice(0, 700);
      return { intent: 'help', reply: body, sources: [{ kind: 'help', slug: helpTop.slug, label: helpTop.title }], quicks: help.slice(1, 3).filter((h) => helpRelevant(h)).map((h) => ({ label: h.title.slice(0, 30), send: h.title })) };
    }

    // Allgemeinwissen (wikilite) NUR bei echten Wissensfragen, ohne Quellenangabe.
    const knowledge = /^(wer |was |wann |wo |warum |wieso |welche|wie viel|wie hoch|wie lang|wie funktioniert|erklär|definiere)/.test(low) || /\b(bedeutet|hauptstadt von|geboren|gestorben|erfinder von|geschichte von)\b/.test(low);
    if (knowledge) {
      const wiki = await wikiSearch(t).catch(() => null);
      if (wiki && wiki.text) return { intent: 'wiki', reply: wiki.text };
    }

    // Fallback: ehrlich sagen + Ticket anbieten
    return { intent: 'unknown', reply: 'Das weiß ich nicht sicher. Soll ich dazu ein Ticket an den Support anlegen? Dann kümmert sich ein Mensch darum.', quicks: [{ label: 'Ja, Ticket', send: 'Ich möchte ein Support-Ticket erstellen' }, { label: 'Nein', send: 'nein danke' }] };
  }

  // ================= HTTP-Endpunkte =================

  // Chat
  app.post('/bot/chat', auth, rateLimitUser('bot-chat', 60, 60000), asyncRoute(async (req, res) => {
    const text = vStr(req.body.text, 'Nachricht', 2000);
    const settings = await getSettings(req.uid);
    const sid = await ensureSession(req.uid, req.body.session_id, settings.share_chats);
    await saveChat(sid, req.uid, 'user', text, null);
    // Auto-Titel: erste Nutzernachricht wird zum Chat-Titel (falls noch keiner gesetzt).
    pool.execute("UPDATE bot_sessions SET title=? WHERE session_id=? AND (title IS NULL OR title='')", [text.slice(0, 60), sid]).catch(() => {});
    scanMemory(req.uid, text).catch(() => {});
    // Support-Ticket-Direktstart
    if (/support.?ticket|ticket erstellen|hilfe vom support|an den support/.test(text.toLowerCase()) && !flows.get(fkey(req.uid, sid))) {
      startFlow(req.uid, sid, 'ticket');
      const reply = FLOW_DEFS.ticket.slots[0].ask;
      const tmeta = ttsMetaFor('flow');
      const tid = await saveChat(sid, req.uid, 'bot', reply, 'flow', tmeta);
      const tcls = ttsPolicy.classifyTtsContent(tmeta, reply);
      return res.json({ session_id: sid, reply: applyTone(reply, settings.bot_tone), intent: 'flow', message_id: tid, tts: { classification: tcls.classification, cloudEligible: false, localEligible: ttsPolicy.isLocalTtsAllowed(tcls.classification, tcls.forbidden), policyVersion: tcls.policyVersion } });
    }
    const out = await route(req.uid, sid, text, settings);
    const meta = ttsMetaFor(out.intent);
    const cls = ttsPolicy.classifyTtsContent(meta, out.reply);
    const botMsgId = await saveChat(sid, req.uid, 'bot', out.reply, out.intent, meta);
    res.json({ session_id: sid, reply: applyTone(out.reply, settings.bot_tone), intent: out.intent, quicks: out.quicks || [], sources: out.sources || [], voice: NAMES[settings.assistant === 'man' ? 'man' : 'woman'], message_id: botMsgId, tts: { classification: cls.classification, cloudEligible: (cls.classification === 'PUBLIC' || cls.classification === 'PRIVATE'), localEligible: ttsPolicy.isLocalTtsAllowed(cls.classification, cls.forbidden), policyVersion: cls.policyVersion } });
  }));

  // Verlauf einer Session
  app.get('/bot/history/:sid', auth, asyncRoute(async (req, res) => {
    const sid = vStr(req.params.sid, 'Session', 40);
    const [rows] = await pool.execute('SELECT role, text, created_at FROM bot_chat WHERE session_id=? AND user_id=? ORDER BY id ASC LIMIT 200', [sid, req.uid]);
    res.json(rows);
  }));

  // Multi-Chat: Liste der eigenen Chats + Loeschen
  app.get('/bot/sessions', auth, asyncRoute(async (req, res) => {
    const [rows] = await pool.execute("SELECT session_id, COALESCE(NULLIF(title,''),'Neuer Chat') AS title, msg_count, last_at FROM bot_sessions WHERE user_id=? AND msg_count>0 ORDER BY last_at DESC LIMIT 20", [req.uid]);
    res.json(rows);
  }));
  app.delete('/bot/sessions/:sid', auth, asyncRoute(async (req, res) => {
    const sid = vStr(req.params.sid, 'Session', 40);
    await pool.execute('DELETE FROM bot_chat WHERE session_id=? AND user_id=?', [sid, req.uid]);
    await pool.execute('DELETE FROM bot_sessions WHERE session_id=? AND user_id=?', [sid, req.uid]);
    res.json({ ok: true });
  }));

  // Bot-Gedächtnis: ansehen + löschen (DSGVO)
  app.get('/bot/memory', auth, asyncRoute(async (req, res) => {
    const [rows] = await pool.execute('SELECT id, mkey, mval, updated_at FROM bot_user_memory WHERE user_id=? ORDER BY updated_at DESC', [req.uid]);
    res.json(rows);
  }));
  app.delete('/bot/memory/:id', auth, asyncRoute(async (req, res) => {
    const id = vInt(req.params.id, 'Eintrag', 1, 4294967295);
    await pool.execute('DELETE FROM bot_user_memory WHERE id=? AND user_id=?', [id, req.uid]);
    res.json({ ok: true });
  }));
  app.post('/bot/memory/clear', auth, asyncRoute(async (req, res) => {
    await pool.execute('DELETE FROM bot_user_memory WHERE user_id=?', [req.uid]);
    res.json({ ok: true });
  }));

  // SEC-003: TTS nur per Nachrichtenreferenz (message_id). Server klassifiziert + prueft Opt-in + redigiert.
  // KEIN beliebiger Client-Text, KEINE vom Client gesendete Klasse, KEIN Edge-Fallback.
  const ttsCache = new Map(); // key (nur PUBLIC) -> Buffer
  function logTts(reqId, uid, mid, provider, classification, decision, redacted, textLen, status, dur) {
    // Feste JSON-Struktur, nur technische Felder, KEIN Text/Name/Inhalt, Laengenlimit (SEC-003 Punkt 12).
    const rec = { rid: String(reqId), mid: Number(mid) || 0, provider: provider || null, classification: classification || null, decision: String(decision), redaction_applied: !!redacted, text_length: Number(textLen) || 0, status: Number(status) || 0, duration_ms: Number(dur) || 0 };
    let m = JSON.stringify(rec); if (m.length > 500) m = m.slice(0, 500);
    logEvent('info', 'tts', m, { uid });
  }
  app.post('/bot/tts', auth, rateLimitUser('bot-tts', 90, 60000), asyncRoute(async (req, res) => {
    const reqId = crypto.randomBytes(6).toString('hex');
    const t0 = Date.now();
    const messageId = vInt(req.body.message_id, 'Nachricht', 1, 4294967295);
    const explicit = req.body.explicit === true || req.body.explicit === 1;
    const voiceKey = vEnum(req.body.voice, 'Stimme', ['man', 'woman'], { optional: true }) || 'woman';
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Nachricht strikt an den eingeloggten Nutzer gebunden laden.
    const [[msg]] = await pool.execute('SELECT id, user_id, role, text, tts_meta FROM bot_chat WHERE id=? AND user_id=?', [messageId, req.uid]);
    if (!msg || msg.role !== 'bot') { logTts(reqId, req.uid, messageId, null, null, 'not_found', false, 0, 404, Date.now() - t0); return res.status(404).json({ error: 'Nachricht nicht gefunden' }); }
    let meta = {}; try { meta = msg.tts_meta ? (typeof msg.tts_meta === 'string' ? JSON.parse(msg.tts_meta) : msg.tts_meta) : {}; } catch (e) { meta = {}; }
    const settings = await getSettings(req.uid);
    const d = ttsPolicy.decideTts({ meta, text: msg.text, settings, explicit, cloudAvailable: CLOUD_TTS_AVAILABLE, currentPrivacyNoticeVersion: ttsPolicy.TTS_PRIVACY_NOTICE_VERSION }); // Client-Klasse wird ignoriert
    if (d.action !== 'cloud') {
      logTts(reqId, req.uid, messageId, null, d.classification, 'blocked:' + d.reason, false, String(msg.text).length, 200, Date.now() - t0);
      // Server behauptet KEINE lokale Verfuegbarkeit; nur ob lokale Ausgabe grundsaetzlich zulaessig waere.
      return res.status(200).json({ mode: 'blocked', localEligible: !!d.localEligible, classification: d.classification, reason: d.reason, policyVersion: d.policyVersion });
    }
    // Cloud erlaubt: nur PUBLIC/PRIVATE + Opt-in + konkreter Klick. PRIVATE wird redigiert.
    let outText = spoken(msg.text);
    let redacted = false;
    if (d.redact) { const r = ttsPolicy.redactTtsContent(outText, d.classification); outText = r.text; redacted = r.redactionApplied; }
    if (d.classification === 'PUBLIC') {
      const key = ['elevenlabs', voiceKey, 'de', d.policyVersion, crypto.createHash('sha1').update(outText).digest('hex')].join('|');
      if (ttsCache.has(key)) { logTts(reqId, req.uid, messageId, 'cache', d.classification, 'allowed', redacted, outText.length, 200, Date.now() - t0); res.setHeader('Content-Type', 'audio/mpeg'); return res.send(ttsCache.get(key)); }
      const el = await elevenTTS(outText, voiceKey).catch(() => null);
      if (!el || el.length <= 200) { logTts(reqId, req.uid, messageId, 'elevenlabs', d.classification, 'provider_failed', redacted, outText.length, 503, Date.now() - t0); return res.status(503).json({ error: 'Sprachausgabe nicht verfügbar' }); }
      if (ttsCache.size > 200) ttsCache.clear();
      ttsCache.set(key, el);
      logTts(reqId, req.uid, messageId, 'elevenlabs', d.classification, 'allowed', redacted, outText.length, 200, Date.now() - t0);
      res.setHeader('Content-Type', 'audio/mpeg'); return res.send(el);
    }
    // PRIVATE: kein gemeinsamer Cache.
    const el = await elevenTTS(outText, voiceKey).catch(() => null);
    if (!el || el.length <= 200) { logTts(reqId, req.uid, messageId, 'elevenlabs', d.classification, 'provider_failed', redacted, outText.length, 503, Date.now() - t0); return res.status(503).json({ error: 'Sprachausgabe nicht verfügbar' }); }
    logTts(reqId, req.uid, messageId, 'elevenlabs', d.classification, 'allowed', redacted, outText.length, 200, Date.now() - t0);
    res.setHeader('Content-Type', 'audio/mpeg'); return res.send(el);
  }));

  // SEC-003: Cloud-TTS Opt-in / Widerruf (serverseitig, mit Zeitstempeln). Default bleibt 0.
  app.post('/bot/tts-settings', auth, asyncRoute(async (req, res) => {
    const enable = req.body.cloud_tts_enabled === true || req.body.cloud_tts_enabled === 1;
    // Globale Sperre: solange CLOUD_TTS_AVAILABLE!=1 kann NIEMAND aktivieren.
    if (enable && !CLOUD_TTS_AVAILABLE) {
      return res.status(200).json({ ok: false, cloud_tts_available: false, message: 'Cloud-Sprachausgabe ist derzeit nicht verfügbar.' });
    }
    if (enable) {
      const provider = ttsPolicy.CLOUD_TTS_PROVIDERS[0]; // Provider-Allowlist: nur 'elevenlabs', kein Client-Wert
      await pool.execute('UPDATE user_settings SET cloud_tts_enabled=1, cloud_tts_provider=?, cloud_tts_enabled_at=NOW(), cloud_tts_revoked_at=NULL, cloud_tts_privacy_version=? WHERE user_id=?', [provider, ttsPolicy.TTS_PRIVACY_NOTICE_VERSION, req.uid]);
    } else {
      await pool.execute('UPDATE user_settings SET cloud_tts_enabled=0, cloud_tts_provider=NULL, cloud_tts_revoked_at=NOW() WHERE user_id=?', [req.uid]);
    }
    const [[s]] = await pool.execute('SELECT cloud_tts_enabled, cloud_tts_provider, cloud_tts_enabled_at, cloud_tts_revoked_at, cloud_tts_privacy_version FROM user_settings WHERE user_id=?', [req.uid]);
    res.json({ ok: true, cloud_tts_available: CLOUD_TTS_AVAILABLE, settings: s });
  }));

  // ---------- Tickets (Nutzer) ----------
  app.get('/tickets', auth, asyncRoute(async (req, res) => {
    const [rows] = await pool.execute(
      'SELECT t.id, t.subject, t.category, t.status, t.created_at, t.updated_at, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id=t.id) msgs FROM tickets t WHERE t.user_id=? ORDER BY t.updated_at DESC LIMIT 100', [req.uid]);
    res.json(rows);
  }));
  app.post('/tickets', auth, rateLimitUser('ticket-new', 20), asyncRoute(async (req, res) => {
    const subject = vStr(req.body.subject, 'Betreff', 200);
    const text = vStr(req.body.text, 'Nachricht', 4000);
    const category = vStr(req.body.category, 'Kategorie', 40, { optional: true }) || 'allgemein';
    const [r] = await pool.execute('INSERT INTO tickets (user_id, subject, category) VALUES (?,?,?)', [req.uid, subject, category]);
    await pool.execute('INSERT INTO ticket_messages (ticket_id, sender, text) VALUES (?,?,?)', [r.insertId, 'user', text]);
    logEvent('info', 'ticket_new', subject.slice(0, 80), { uid: req.uid, ip: reqIp(req) });
    res.json({ ok: true, id: r.insertId });
  }));
  app.get('/tickets/:id', auth, asyncRoute(async (req, res) => {
    const id = vInt(req.params.id, 'Ticket', 1, 4294967295);
    const [[t]] = await pool.execute('SELECT id, subject, category, status, created_at FROM tickets WHERE id=? AND user_id=?', [id, req.uid]);
    if (!t) return res.status(404).json({ error: 'Ticket nicht gefunden' });
    const [msgs] = await pool.execute('SELECT sender, text, created_at FROM ticket_messages WHERE ticket_id=? ORDER BY id ASC', [id]);
    res.json({ ticket: t, messages: msgs });
  }));
  app.post('/tickets/:id/reply', auth, rateLimitUser('ticket-reply', 40), asyncRoute(async (req, res) => {
    const id = vInt(req.params.id, 'Ticket', 1, 4294967295);
    const text = vStr(req.body.text, 'Antwort', 4000);
    const [[t]] = await pool.execute('SELECT id FROM tickets WHERE id=? AND user_id=?', [id, req.uid]);
    if (!t) return res.status(404).json({ error: 'Ticket nicht gefunden' });
    await pool.execute('INSERT INTO ticket_messages (ticket_id, sender, text) VALUES (?,?,?)', [id, 'user', text]);
    await pool.execute("UPDATE tickets SET status=IF(status='geschlossen','offen',status), updated_at=CURRENT_TIMESTAMP WHERE id=?", [id]);
    res.json({ ok: true });
  }));

  // ---------- Tickets (Admin) ----------
  app.get('/admin/tickets', auth, requireAdmin, asyncRoute(async (req, res) => {
    const status = vEnum(req.query.status, 'Status', ['offen', 'in_arbeit', 'geschlossen'], { optional: true });
    const params = []; let where = '';
    if (status) { where = 'WHERE t.status=?'; params.push(status); }
    const [rows] = await pool.execute(
      `SELECT t.id, t.subject, t.category, t.status, t.created_at, t.updated_at, u.name userName, u.email userEmail,
        (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id=t.id) msgs,
        (SELECT sender FROM ticket_messages m WHERE m.ticket_id=t.id ORDER BY m.id DESC LIMIT 1) lastSender
       FROM tickets t LEFT JOIN users u ON u.id=t.user_id ${where} ORDER BY (t.status='geschlossen') ASC, t.updated_at DESC LIMIT 300`, params);
    res.json(rows);
  }));
  app.get('/admin/tickets/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
    const id = vInt(req.params.id, 'Ticket', 1, 4294967295);
    const [[t]] = await pool.execute('SELECT t.*, u.name userName, u.email userEmail FROM tickets t LEFT JOIN users u ON u.id=t.user_id WHERE t.id=?', [id]);
    if (!t) return res.status(404).json({ error: 'Ticket nicht gefunden' });
    const [msgs] = await pool.execute('SELECT sender, text, created_at FROM ticket_messages WHERE ticket_id=? ORDER BY id ASC', [id]);
    res.json({ ticket: t, messages: msgs });
  }));
  app.post('/admin/tickets/:id/reply', auth, requireAdmin, asyncRoute(async (req, res) => {
    const id = vInt(req.params.id, 'Ticket', 1, 4294967295);
    const text = vStr(req.body.text, 'Antwort', 4000);
    const [[t]] = await pool.execute('SELECT user_id, subject FROM tickets WHERE id=?', [id]);
    if (!t) return res.status(404).json({ error: 'Ticket nicht gefunden' });
    await pool.execute('INSERT INTO ticket_messages (ticket_id, sender, text) VALUES (?,?,?)', [id, 'admin', text]);
    await pool.execute("UPDATE tickets SET status=IF(status='offen','in_arbeit',status), updated_at=CURRENT_TIMESTAMP WHERE id=?", [id]);
    await botPost(t.user_id, 'ticket_reply', 'ticket-' + id, 'life-buoy', '#60a5fa', 'Antwort auf dein Ticket', 'Der Support hat auf "' + String(t.subject).slice(0, 60) + '" geantwortet.');
    res.json({ ok: true });
  }));
  app.post('/admin/tickets/:id/status', auth, requireAdmin, asyncRoute(async (req, res) => {
    const id = vInt(req.params.id, 'Ticket', 1, 4294967295);
    const status = vEnum(req.body.status, 'Status', ['offen', 'in_arbeit', 'geschlossen']);
    await pool.execute('UPDATE tickets SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, id]);
    res.json({ ok: true });
  }));

  // ---------- Admin: Konversations-Archiv ----------
  app.get('/admin/bot-sessions', auth, requireAdmin, rateLimitUser('admin-bot', 120, 60000), asyncRoute(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT s.session_id, s.user_id, s.started_at, s.last_at, s.msg_count, s.shared, u.name userName, u.email userEmail
       FROM bot_sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.shared=1 ORDER BY s.last_at DESC LIMIT 200`);
    res.json(rows);
  }));
  app.get('/admin/bot-sessions/:sid', auth, requireAdmin, rateLimitUser('admin-bot', 120, 60000), asyncRoute(async (req, res) => {
    const sid = vStr(req.params.sid, 'Session', 40);
    const [[s]] = await pool.execute('SELECT user_id, shared FROM bot_sessions WHERE session_id=?', [sid]);
    if (!s || !s.shared) return res.status(403).json({ error: 'Diese Konversation wurde nicht zur Auswertung freigegeben.' });
    // SEC-BOT-SESSION: jeder Admin-Zugriff auf einen fremden Chat wird auditiert (Akteur + Ziel + Session, OHNE Inhalt).
    logEvent('info', 'admin_bot_read', 'Admin öffnete Bot-Konversation ' + sid.slice(0, 12) + '… von Nutzer #' + s.user_id, { uid: req.uid, ip: reqIp(req) });
    // SEC-BOT-SESSION: nur Nachrichten des Session-Besitzers ausliefern (bindet an den Owner statt nur an die session_id).
    const [rows] = await pool.execute('SELECT role, text, intent, created_at FROM bot_chat WHERE session_id=? AND user_id=? ORDER BY id ASC LIMIT 500', [sid, s.user_id]);
    res.json(rows);
  }));

  // ---------- Hilfecenter ----------
  app.get('/help', auth, asyncRoute(async (req, res) => {
    const [cats] = await pool.execute('SELECT id, slug, title, icon FROM help_categories ORDER BY sort, id');
    const [arts] = await pool.execute('SELECT id, category_id, slug, title, body, is_faq FROM help_articles ORDER BY sort, id');
    res.json({ categories: cats, articles: arts });
  }));
  app.post('/admin/help', auth, requireAdmin, asyncRoute(async (req, res) => {
    const title = vStr(req.body.title, 'Titel', 200);
    const body = vStr(req.body.body, 'Inhalt', 20000);
    const slug = (vStr(req.body.slug, 'Slug', 80, { optional: true }) || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    const category_id = vInt(req.body.category_id, 'Kategorie', 1, 4294967295, { optional: true });
    const keywords = vStr(req.body.keywords, 'Stichworte', 500, { optional: true }) || '';
    const is_faq = vBool(req.body.is_faq);
    if (req.body.id) {
      const id = vInt(req.body.id, 'Beitrag', 1, 4294967295);
      await pool.execute('UPDATE help_articles SET title=?, body=?, keywords=?, is_faq=?, category_id=? WHERE id=?', [title, body, keywords, is_faq, category_id, id]);
      return res.json({ ok: true, id });
    }
    try { const [r] = await pool.execute('INSERT INTO help_articles (category_id, slug, title, body, keywords, is_faq) VALUES (?,?,?,?,?,?)', [category_id, slug, title, body, keywords, is_faq]); res.json({ ok: true, id: r.insertId }); }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') throw bad('Slug existiert schon'); throw e; }
  }));
  app.delete('/admin/help/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
    const id = vInt(req.params.id, 'Beitrag', 1, 4294967295);
    await pool.execute('DELETE FROM help_articles WHERE id=?', [id]);
    res.json({ ok: true });
  }));
  app.post('/admin/help/category', auth, requireAdmin, asyncRoute(async (req, res) => {
    const title = vStr(req.body.title, 'Titel', 120);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const icon = vStr(req.body.icon, 'Icon', 30, { optional: true }) || 'book';
    try { const [r] = await pool.execute('INSERT INTO help_categories (slug, title, icon) VALUES (?,?,?)', [slug, title, icon]); res.json({ ok: true, id: r.insertId }); }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') throw bad('Kategorie existiert schon'); throw e; }
  }));

  console.log('[bot] Routen registriert (Chat, Tickets, Hilfe, TTS, Gedächtnis)');
};
