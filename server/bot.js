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
  // Vorher wurden ALLE Punkte blind geloescht, bevor die Zahl gelesen wurde: aus "12.50" wurde
  // "1250", also das Hundertfache. In einer Finanz-App der schlimmstmoegliche Fehler.
  // Regel: Komma ist immer Dezimaltrenner. Ohne Komma ist ein Punkt nur dann Tausendertrenner,
  // wenn genau drei Ziffern folgen ("12.500"), sonst ist er ein Dezimalpunkt ("12.50").
  function parseAmount(t) {
    const m = String(t).match(/-?\d[\d.,]*/);
    if (!m) return null;
    let v = m[0].replace(/[.,]+$/, '');
    if (v.indexOf(',') >= 0) {
      v = v.replace(/\./g, '').replace(',', '.');
    } else {
      const dots = (v.match(/\./g) || []).length;
      if (dots > 1) v = v.replace(/\./g, '');
      else if (dots === 1 && (v.split('.')[1] || '').length === 3) v = v.replace('.', '');
    }
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
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
    if ((m = text.match(/\b(?:wohne|lebe) in\s+([A-Za-zÄÖÜäöüß.-]{2,40}(?:\s[A-Za-zÄÖÜäöüß.-]{2,20})?)/i))) save('Wohnort', m[1].trim());
    if ((m = text.match(/ich spare (?:auf|für)\s+(?:ein |eine |einen )?([A-Za-zÄÖÜäöüß ]{3,40})/i))) save('Sparziel', m[1].trim());
  }

  // ---------- laufende Aktions-Flows (im RAM; nach Neustart weg, unkritisch) ----------
  const flows = new Map(); // key uid:sid -> { type, step, data, awaitConfirm }
  const fkey = (uid, sid) => uid + ':' + sid;

  // ---------- Ton ----------
  // Der Tonfall war frueher eine Attrappe: alle drei Zweige gaben denselben Text zurueck, obwohl
  // die App "feuert dich an und lobt deine Fortschritte" verspricht.
  // WICHTIG: nur bei unverfaenglichen Intents anwenden. Ein "Du packst das!" hinter der
  // Telefonseelsorge-Antwort oder hinter einer Beleidigungsgrenze waere uebergriffig.
  const TONE_SAFE = new Set(['data', 'domain', 'food_info', 'help', 'wiki', 'smalltalk', 'greet', 'joke', 'memory', 'weather']);
  const TONE_ADD = {
    locker: ['', '', '', 'Sag Bescheid, wenn du noch was brauchst.', 'Passt das so?', 'Frag ruhig weiter.'],
    coach: ['Dranbleiben lohnt sich!', 'Du packst das.', 'Weiter so!', 'Kleine Schritte zählen auch.', 'Bleib dran, das zahlt sich aus.', ''],
  };
  const TONE_PRE = {
    locker: ['', '', '', 'Klar: ', 'Also: '],
    coach: ['', '', 'Gute Frage: ', 'Stark, dass du fragst: '],
  };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  function applyTone(text, tone, intent) {
    if (!tone || tone === 'neutral') return text;
    const base = String(intent || '').split(':')[0];
    if (!TONE_SAFE.has(base)) return text;
    const pre = TONE_PRE[tone] ? pick(TONE_PRE[tone]) : '';
    const add = TONE_ADD[tone] ? pick(TONE_ADD[tone]) : '';
    // Nicht kleinschreiben: im Deutschen werden Substantive gross geschrieben, aus "Nutella"
    // wurde sonst "nutella".
    let out = String(text);
    if (pre) out = pre + out;
    if (add) out = out + ' ' + add;
    return out;
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
  // "kaese" -> "käse". Viele tippen ohne Umlaute, die Datenbank hat sie aber. Nur als Rueckfallebene
  // benutzen, sonst wuerde aus "neue" faelschlich "nü".
  function unfoldUmlaut(s) {
    return String(s).replace(/ae/g, 'ä').replace(/oe/g, 'ö').replace(/ue/g, 'ü').replace(/ss/g, 'ß');
  }
  async function foodSearch(q, limit, nameOnly) {
    const toks = String(q).toLowerCase().split(/[^a-z0-9äöüß]+/i).filter(t => t.length >= 3);
    let rows = [];
    if (toks.length) {
      const bool = toks.map(t => '+' + t + '*').join(' ');
      const sql = 'SELECT name, brand, kcal, carbs, protein, fat FROM foods WHERE MATCH(name, brand) AGAINST (? IN BOOLEAN MODE) ' +
        (nameOnly ? 'AND name LIKE ? ' : '') +
        'ORDER BY (name LIKE ?) DESC, (kcal BETWEEN 20 AND 900) DESC, (kcal>0) DESC, LENGTH(name) ASC LIMIT ?';
      const args = nameOnly ? [bool, '%' + toks[0] + '%', toks[0] + '%', limit] : [bool, toks[0] + '%', limit];
      [rows] = await pool.execute(sql, args);
    }
    if (!rows.length && !nameOnly) {
      [rows] = await pool.execute(
        'SELECT name, brand, kcal, carbs, protein, fat FROM foods WHERE name LIKE ? ORDER BY (name LIKE ?) DESC, (kcal>0) DESC, LENGTH(name) ASC LIMIT ?',
        ['%' + q + '%', q + '%', limit]);
    }
    return rows;
  }
  async function foodCandidates(q, limit = 6) {
    const base = String(q).toLowerCase(), alt = unfoldUmlaut(base);
    const variants = alt !== base ? [base, alt] : [base];
    let rows = [];
    // Erst Treffer im NAMEN (in jeder Schreibweise), sonst gewinnt eine zufaellig passende Marke
    // wie "Kaeselager.De" gegen die eigentlich gesuchte Kaese-Sorte.
    for (const v of variants) { rows = await foodSearch(v, limit, true); if (rows.length) break; }
    if (!rows.length) for (const v of variants) { rows = await foodSearch(v, limit, false); if (rows.length) break; }
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
    delTx: {
      title: 'Buchung löschen',
      slots: [],
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
    if (f.type === 'delTx') {
      const [r] = await pool.execute('DELETE FROM transactions WHERE id=? AND user_id=?', [d.id, uid]);
      if (!r || !r.affectedRows) return 'Die Buchung habe ich nicht mehr gefunden, da ist nichts gelöscht worden.';
      logEvent('info', 'bot_tx_deleted', 'Buchung per Assistent gelöscht', { uid });
      return 'Erledigt, die Buchung ist gelöscht. Dein Finanzbuch ist wieder aktuell.';
    }
    if (f.type === 'ticket') {
      const [r] = await pool.execute('INSERT INTO tickets (user_id, subject, category) VALUES (?,?,?)', [uid, d.subject, 'bot']);
      await pool.execute('INSERT INTO ticket_messages (ticket_id, sender, text) VALUES (?,?,?)', [r.insertId, 'user', d.description]);
      logEvent('info', 'bot_ticket', d.subject.slice(0, 80), { uid });
      return `Dein Ticket ist erstellt (Nr. ${r.insertId}). Du findest es unter "Meine Tickets", der Support meldet sich.`;
    }
    return 'Erledigt.';
  }

  // ---------- Sprachnormalisierung ----------
  // Umlaute/ss falten, damit "eiweiss" und "eiweiß" gleich behandelt werden. Ohne das rutschte
  // "wie viel eiweiss hat huehnchen" an der Naehrwert-Regel vorbei bis in die Wikipedia-Suche.
  const foldTxt = (s) => String(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ').trim();

  // ---------- Beleidigungen ----------
  const INSULT_RE = /\b(idiot(en)?|vollidiot|dumm(kopf|es|er|e)?|bloed(e|er|es)?|daemlich|schwachkopf|schwachsinn|arsch(loch)?|fotze|fick|ficken|hurensohn|wichser|spast|spasti|behindert|missgeburt|penner|opfer|nutte|schlampe|kacke|kack|scheiss(e|dreck|bot|ding)?|fresse|schnauze|verpiss|halt(s)? maul|dumme kuh|bloede kuh|du (bist|kannst) (nichts|nix)|nutzlos|unfaehig|muell|schrott|hirnlos|trottel|depp|vollpfosten)\b/;
  const INSULT_REPLIES = [
    'Das lasse ich mal so stehen. Sag mir lieber, was du brauchst, dann helfe ich dir.',
    'Ich merke, du bist genervt. Kein Ding, aber beleidigen bringt uns nicht weiter. Woran hakt es gerade?',
    'Ich bleibe trotzdem freundlich. Wenn etwas nicht klappt, sag mir was, dann versuchen wir es zusammen.',
    'Okay, das reicht jetzt aber. Ich helfe dir gern, wenn du sachlich bleibst.',
    'Ich bin ein Assistent, kein Boxsack. Sag mir dein Anliegen, dann kümmere ich mich darum.',
  ];
  const INSULT_HARD = 'So kommen wir nicht weiter. Ich beantworte gern jede Frage zur App, zu Ernährung oder zu deinen Zahlen, aber auf Beleidigungen gehe ich nicht mehr ein.';
  // Merkt sich das zuletzt genannte Lebensmittel pro Unterhaltung, damit Rueckbezuege wie
  // "und ist das gesund?" nach einer Naehrwert-Antwort funktionieren.
  const lastFood = new Map();
  const rememberFood = (uid, sid, name, kcal) => {
    const k = uid + ':' + sid;
    lastFood.set(k, { name, kcal });
    if (lastFood.size > 500) lastFood.delete(lastFood.keys().next().value);
  };
  // Merkt sich, dass der Bot gerade selbst etwas gefragt hat. Ohne das antwortete er auf
  // "Nenn mir eine Stadt" -> "birkenbeul" mit "Das habe ich nicht verstanden".
  const pendingAsk = new Map();
  const setAsk = (uid, sid, what) => {
    pendingAsk.set(uid + ':' + sid, { what, at: Date.now() });
    if (pendingAsk.size > 500) pendingAsk.delete(pendingAsk.keys().next().value);
  };
  const takeAsk = (uid, sid) => {
    const k = uid + ':' + sid, v = pendingAsk.get(k);
    pendingAsk.delete(k);
    // Nur kurz gueltig, sonst wird eine spaetere Nachricht faelschlich als Antwort gedeutet.
    return v && Date.now() - v.at < 180000 ? v.what : null;
  };
  const insultCount = new Map();
  const bumpInsult = (uid, sid) => {
    const k = uid + ':' + sid, n = (insultCount.get(k) || 0) + 1;
    insultCount.set(k, n);
    if (insultCount.size > 500) { const first = insultCount.keys().next().value; insultCount.delete(first); }
    return n;
  };

  // ---------- Gefuehle / Belastung ----------
  // Wichtig: Bei Hinweisen auf ernste Not KEIN Support-Ticket anbieten, sondern echte Hilfe nennen.
  // Zwei Stufen, weil beides falsch waere: einen Hilferuf verpassen, oder jemandem wegen
  // Kopfschmerzen die Telefonseelsorge unter die Nase halten.
  // STUFE 1, eindeutig: volle Krisenantwort.
  // Wortstaemme statt ganzer Woerter: "ritzen" traf "ich ritze mich" nicht.
  const CRISIS_RE = new RegExp([
    'bringe? mich um', '\\bumbringen\\b', '\\bselbstmord\\b', '\\bsuizid', '\\bsuizidal\\b',
    'nicht mehr leben', 'leben beenden', 'mich toeten', 'toete mich', 'mag nicht mehr leben',
    // "sich das Leben nehmen" ist die haeufigste deutsche Formulierung und fehlte komplett
    '(mir|sich|mein)[^.?!]{0,12}leben[^.?!]{0,8}nehmen', 'leben nehmen',
    // Selbstverletzung: Stamm, damit ritze/ritzt/geritzt greifen
    '\\britz(e|en|t|te|est)\\b', 'geritzt', 'selbstverletz',
    '(verletze|verletzen)[^.?!]{0,10}(mich|mir)', '(mich|mir)[^.?!]{0,10}(selbst )?(verletzen|weh tun|wehtun)',
    'tue mir[^.?!]{0,8}weh', 'arme? aufgeschnitten', '\\bpulsadern\\b',
    // Ueberdosis
    '(tabletten|pillen|medikamente)[^.?!]{0,15}(geschluckt|genommen|eingeworfen)',
    'ueberdosis', 'zu viele tabletten',
    'will sterben', 'sterben wollen', 'waere besser tot', 'lieber tot', 'nicht mehr aufwachen',
    'keinen sinn mehr', 'alles[^.?!]{0,12}sinnlos', 'leben[^.?!]{0,12}sinnlos',
    '(keiner|niemand)[^.?!]{0,12}(wuerde|wurde)[^.?!]{0,8}vermissen',
    'welt[^.?!]{0,12}ohne mich[^.?!]{0,12}besser', 'ohne mich[^.?!]{0,10}besser dran',
    'schluss machen mit allem', 'will nicht mehr\\s*[.!]*$',
  ].join('|'));

  // STUFE 2, Belastung ohne eindeutigen Hinweis: zuhoeren und Hilfe NENNEN, ohne Alarm zu schlagen.
  const DISTRESS_RE = new RegExp([
    'keinen ausweg', 'kein ausweg', 'bin am ende', 'am ende meiner kraft',
    'halte das nicht mehr aus', 'ertrage das nicht mehr', 'weiss nicht mehr weiter',
    'kann so nicht mehr', 'schaffe das nicht mehr', 'alles zu viel fuer mich',
  ].join('|'));
  const DISTRESS_REPLY = 'Das klingt, als würde dir gerade sehr viel über den Kopf wachsen. Ich bin nur ein Assistent in einer App und kann dir dabei ehrlich nicht helfen. Wenn es dir wirklich schlecht geht, kannst du jederzeit kostenlos und anonym mit jemandem sprechen: Die Telefonseelsorge ist rund um die Uhr unter 0800 111 0 111 erreichbar. Und wenn ich dir hier bei etwas Kleinem den Kopf frei machen kann, sag Bescheid.';
  const CRISIS_REPLY = 'Das klingt, als ginge es dir gerade richtig schlecht, und das tut mir leid. Ich bin nur ein Assistent in einer App und kann dir dabei nicht helfen, aber es gibt Menschen, die das können: Die Telefonseelsorge ist rund um die Uhr kostenlos erreichbar unter 0800 111 0 111 oder 0800 111 0 222, auch anonym. Wenn es akut ist, ruf bitte den Notruf 112. Bitte sprich mit jemandem.';
  // Bewusst tolerant: Menschen schreiben "mir gehts heute ehrlich gesagt nicht so gut", nicht "mir geht es schlecht".
  const SAD_RE = new RegExp([
    'mir (geht|gehts|geht es)[^.?!]{0,25}(schlecht|mies|dreckig|beschissen|nicht so gut|nicht gut|nicht besonders)',
    'geht mir[^.?!]{0,25}(schlecht|mies|dreckig|nicht so gut|nicht gut)',
    '\\bbin (grad |gerade |heute |echt |total |ziemlich |so )*(traurig|fertig|erschoepft|ausgebrannt|kaputt|down|deprimiert|einsam|allein|ungluecklich|verzweifelt)',
    'fuehle mich[^.?!]{0,20}(schlecht|mies|leer|allein|einsam|ueberfordert|wertlos)',
    '\\bschaffe (das|es)[^.?!]{0,15}nicht', '\\bkann nicht mehr\\b', '\\balles zu viel\\b', '\\bueberfordert\\b',
    '\\bhabe angst\\b', '\\bmache mir sorgen\\b',
    '\\bjob verloren\\b', '\\bgekuendigt\\b', '\\barbeit verloren\\b', '\\btrennung\\b', '\\bhat mich verlassen\\b',
    '\\bgestorben\\b', '\\bbeerdigung\\b', '\\bliebeskummer\\b',
  ].join('|'));
  const SAD_REPLIES = [
    'Das klingt nach einem echt schweren Tag, das tut mir leid. Ich bin kein Mensch und kann dir das nicht abnehmen, aber ich bin da. Magst du erzählen, was los ist, oder soll ich dich einfach in Ruhe lassen?',
    'Puh, das klingt belastend. Ich kann nur bei der App, Ernährung und deinen Zahlen helfen, aber wenn dich etwas ablenkt oder du einfach weitermachen willst, sag Bescheid.',
  ];
  const STRESS_REPLY = 'Klingt nach viel auf einmal. Wenn du magst, fangen wir klein an: Ich kann dir zeigen, was heute ansteht, oder eine Aufgabe für dich eintragen, damit du sie nicht im Kopf behalten musst.';

  // ---------- Witze ----------
  // Wurde real mehrfach gefragt, deshalb echte Witze statt einer Absage. Rotation pro Unterhaltung.
  const JOKES = [
    'Treffen sich zwei Kalorien. Sagt die eine: "Puh, ist das heiß hier." Sagt die andere: "Klar, wir sind ja auch in der Pfanne."',
    'Was macht ein Keks unter einem Baum? Krümeln.',
    'Ich wollte ja abnehmen, aber der Kühlschrank hat mich immer wieder zurückgerufen.',
    'Warum können Geister so schlecht lügen? Weil man durch sie hindurchsieht.',
    'Wie nennt man einen Bumerang, der nicht zurückkommt? Stock.',
    'Mein Arzt sagte, ich soll mehr Gemüse essen. Jetzt nehme ich immer die Gurke aus dem Burger mit.',
    'Was sagt ein Nulleuroschein zum anderen? Wir sind nichts wert, aber immerhin zu zweit.',
    'Ich habe meinem Sparschwein erzählt, dass ich sparen will. Seitdem lacht es nur noch.',
    'Warum trinken Mathematiker keinen Alkohol? Weil sie sonst nicht mehr geradeaus rechnen können.',
    'Sport ist Mord. Aber Salat ist auch kein Leben.',
  ];
  const jokeIdx = new Map();
  const nextJoke = (uid, sid) => {
    const k = uid + ':' + sid, i = (jokeIdx.get(k) || 0) % JOKES.length;
    jokeIdx.set(k, i + 1);
    if (jokeIdx.size > 500) jokeIdx.delete(jokeIdx.keys().next().value);
    return JOKES[i];
  };

  // ---------- Gedaechtnis-Auskunft ----------
  async function memorySummary(uid) {
    const [rows] = await pool.execute('SELECT mkey, mval FROM bot_user_memory WHERE user_id=? ORDER BY updated_at DESC LIMIT 12', [uid]).catch(() => [[]]);
    if (!rows || !rows.length) return null;
    return rows.map(r => `${r.mkey}: ${r.mval}`).join(', ');
  }

  // ---------- Eigenes Glossar ----------
  // Kernbegriffe der App MUESSEN vor die Wikipedia. Sonst antwortet eine Ernaehrungs-App auf
  // "was ist fett" mit einem SS-Gruppenfuehrer aus einer Begriffsklaerung und auf "was ist
  // zucker" mit einer Filmsatire von 1978.
  const GLOSSAR = [
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\bfett(e|en)?\b/, a: 'Fett ist einer der drei Hauptnährstoffe, neben Eiweiß und Kohlenhydraten. Es hat mit rund 9 kcal pro Gramm mehr als doppelt so viel Energie wie die anderen beiden und ist trotzdem lebensnotwendig, etwa für Hormone und die Aufnahme mancher Vitamine. In der App siehst du bei jedem Lebensmittel den Fettanteil pro 100 g.' },
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\bzucker\b/, a: 'Zucker ist eine Untergruppe der Kohlenhydrate und liefert etwa 4 kcal pro Gramm. Er steckt nicht nur in Süßem, sondern auch versteckt in vielen Fertigprodukten. In der App findest du bei jedem Lebensmittel die Kohlenhydrate, in denen der Zucker enthalten ist.' },
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\b(kohlenhydrate?|carbs)\b/, a: 'Kohlenhydrate sind der Hauptenergielieferant des Körpers, etwa 4 kcal pro Gramm. Dazu zählen Zucker, Stärke und Ballaststoffe. In der App siehst du sie bei jedem Lebensmittel pro 100 g.' },
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\b(eiweiss|protein)e?\b/, a: 'Eiweiß, auch Protein genannt, ist der Baustoff für Muskeln, Haut und Enzyme, etwa 4 kcal pro Gramm. Als Faustregel reichen rund 0,8 g pro kg Körpergewicht am Tag, beim Sport eher 1,4 bis 2 g.' },
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\b(kalorien?|kcal)\b/, a: 'Eine Kalorie ist eine Einheit für Energie. Die Angabe kcal auf Lebensmitteln sagt dir, wie viel Energie darin steckt. Nimmst du dauerhaft mehr auf als du verbrauchst, nimmst du zu, bei weniger ab. Genau das rechnet dir die App mit.' },
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\b(grundumsatz|bmr)\b/, a: 'Der Grundumsatz ist die Energie, die dein Körper in völliger Ruhe verbraucht, nur fürs Atmen, Herzschlag und Wärme. Er macht meist den größten Teil deines Tagesbedarfs aus. Zusammen mit deiner Aktivität ergibt er den Gesamtbedarf, den die App aus deinen Körperdaten schätzt.' },
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\bbmi\b/, a: 'Der BMI setzt Gewicht und Größe ins Verhältnis (Gewicht in kg geteilt durch Größe in Metern zum Quadrat). Er ist eine grobe Orientierung und sagt nichts über Muskeln oder Körperbau, deshalb bei Sportlern oft irreführend. Ich bin kein Arzt, das ist nur eine Einordnung.' },
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\b(vitamin ?[abcdek]\d?|vitamine)\b/, a: 'Vitamine sind Stoffe, die dein Körper braucht, aber nicht oder kaum selbst herstellen kann. Sie liefern keine Energie, sind aber für viele Vorgänge nötig. Eine abwechslungsreiche Ernährung deckt sie normalerweise ab. Bei Verdacht auf einen Mangel bitte ärztlich abklären, dazu kann ich nichts sagen.' },
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\b(intervallfasten|intermittierendes fasten|16 ?: ?8)\b/, a: 'Beim Intervallfasten isst du nur in einem festen Zeitfenster, oft 8 Stunden, und lässt den Rest des Tages aus. Es hilft manchen beim Abnehmen, vor allem weil sie insgesamt weniger essen, nicht durch Magie. Ob es zu dir passt, ist Geschmackssache. Ich bin keine Ernährungsberatung.' },
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\b(konto|kontostand|saldo)\b/, a: 'Der Kontostand, auch Saldo, ist die Summe deiner Einnahmen minus deiner Ausgaben. In der App siehst du ihn im Finanzbuch. Frag mich einfach "Wie ist mein Kontostand?", dann sage ich dir deinen aktuellen Stand.' },
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\bzinsen?\b/, a: 'Zinsen sind der Preis für geliehenes Geld. Zahlst du einen Kredit ab, gehen sie an die Bank. Legst du Geld an, bekommst du sie. In der App kannst du bei Krediten den Zinssatz hinterlegen, dann rechne ich dir die Belastung mit.' },
    { re: /\b(was (ist|sind)|erklaer|definier)[^.?!]{0,12}\b(budget)\b/, a: 'Ein Budget ist ein Limit, das du dir für eine Ausgabenkategorie im Monat setzt. Die App warnt dich bei 80, 100 und 120 Prozent, damit du früh merkst, wenn es eng wird.' },
  ];

  // ---------- Domaenenwissen (regelbasiert, ehrlich) ----------
  const DOMAIN = [
    { re: /\b(nehme|nimmt|nimm)\b[^.?!]{0,30}\bab\s*[.?!]*$|\b(abnehmen|abzunehmen|abspecken|gewicht verlieren|schlank werden|diaet|kalorien ?defizit)\b/,
      reply: 'Abnehmen läuft am Ende über ein Kaloriendefizit: dauerhaft etwas weniger essen, als du verbrauchst. Realistisch sind etwa 0,3 bis 0,5 kg pro Woche. Die App hilft dir dabei beim Nachhalten: trag dein Essen im Tagebuch ein, dann siehst du dein Tagesziel und was noch übrig ist. Ich bin aber kein Arzt und keine Ernährungsberatung, bei Vorerkrankungen oder größeren Zielen sprich das bitte ärztlich ab.',
      quicks: [{ label: 'Kalorien heute', send: 'Wie viele Kalorien habe ich heute?' }, { label: 'Essen eintragen', send: 'Ich möchte Essen eintragen' }] },
    { re: /\b(keine lust|kein bock|raff mich nicht|komme nicht in die gaenge|motivier mich|brauche motivation|schaffe es nicht anzufangen)\b/,
      reply: 'Kenne ich, und ehrlich: Motivation kommt meist erst beim Machen, nicht davor. Nimm dir was lächerlich Kleines vor, fünf Minuten reichen. In der App zählt das Training deine Wiederholungen per Kamera mit, da siehst du sofort etwas passieren, das hilft gegen den inneren Schweinehund.',
      quicks: [{ label: 'Training öffnen', send: 'Wie funktioniert das Training?' }] },
    { re: /\b(wie (werde|bleibe) ich fit|fitter werden|muskeln aufbauen|muskelaufbau|mehr sport|sportlicher)\b/,
      reply: 'Fitter wirst du vor allem durch Regelmäßigkeit, nicht durch Intensität. Lieber dreimal pro Woche etwas Kurzes als einmal etwas Riesiges. In der App findest du unter Community und Spiele das Training, da erkennt die Kamera deine Wiederholungen und zählt sie mit. Für Muskelaufbau brauchst du zusätzlich genug Eiweiß, grob 1,4 bis 2 g pro kg Körpergewicht.',
      quicks: [{ label: 'Training öffnen', send: 'Wie funktioniert das Training?' }] },
    { re: /\b(wie viel(e)? (eiweiss|protein) (brauche|braucht)|eiweissbedarf|proteinbedarf)\b/,
      reply: 'Als grobe Richtung: etwa 0,8 g Eiweiß pro kg Körpergewicht am Tag reichen zum Erhalt, beim Sport oder in einer Diät eher 1,4 bis 2 g pro kg. Bei 75 kg wären das also grob 60 g normal und 105 bis 150 g mit Training. Ich bin keine Ernährungsberatung, das ist nur eine Faustregel.' },
    { re: /\b(wie viel(e)? wasser|wie viel trinken|trinkmenge)\b/,
      reply: 'Faustregel sind etwa 30 bis 35 ml pro kg Körpergewicht am Tag, bei 75 kg also grob 2,2 bis 2,6 Liter. Bei Hitze oder Sport mehr. Das ist eine Richtgröße, keine medizinische Vorgabe.' },
    { re: /\bist (nutella|schokolade|pizza|fastfood|zucker|butter|fett|kaese|brot|obst|bier|alkohol|cola) (gesund|ungesund|schlecht|gut)\b|\b(gesund|ungesund) (ist|sind)\b/,
      reply: 'Einzelne Lebensmittel sind selten einfach gesund oder ungesund, es kommt auf die Menge und den Rest des Tages an. Frag mich gern nach den Nährwerten, dann siehst du die Zahlen und kannst selbst einordnen, zum Beispiel "Wie viele Kalorien hat Nutella?".',
      quicks: [{ label: 'Nährwerte nachschlagen', send: 'Wie viele Kalorien hat Nutella?' }] },
  ];

  // ---------- Intent-Router ----------
  async function route(uid, sid, text, settings) {
    const t = text.trim();
    const low = t.toLowerCase();
    const n = foldTxt(t);
    const key = fkey(uid, sid);
    let flow = flows.get(key);

    // Ernste Not hat Vorrang vor allem, auch vor laufenden Flows und vor dem Ticket-Angebot.
    if (CRISIS_RE.test(n)) { flows.delete(key); return { intent: 'crisis', reply: CRISIS_REPLY }; }

    // Belastung ohne eindeutigen Hinweis: zuhoeren und Hilfe nennen, ohne Alarm zu schlagen.
    if (DISTRESS_RE.test(n)) { return { intent: 'empathy', reply: DISTRESS_REPLY }; }

    // Entschuldigung vor der Beleidigungspruefung, sonst schlaegt "sorry, war dumm von mir" als Beleidigung an.
    // Nicht greifen, wenn es um eine Buchung geht: "ich hab mich vertippt bei der letzten ausgabe"
    // ist eine Korrekturbitte, keine Entschuldigung, und gehoert zum Loeschen weiter unten.
    if (/\b(sorry|sry|entschuldigung|entschuldige|tut mir leid|war nicht so gemeint|nicht boese gemeint|mein fehler|verzeihung|war doof von mir|hab mich vertippt)\b/.test(n)
        && !/\b(buchung|ausgabe|einnahme|eintrag|transaktion|gebucht)\b/.test(n)) {
      insultCount.delete(uid + ':' + sid);
      // Wenn gerade ein Dialog laeuft, MUSS er weg. Vorher sagte der Bot "ist vergessen",
      // liess den Dialog aber offen und verbuchte die naechste harmlose Frage als Betrag.
      if (flows.get(key)) { flows.delete(key); return { intent: 'cancel', reply: 'Kein Problem, ich habe nichts eingetragen. Womit kann ich dir helfen?' }; }
      return { intent: 'smalltalk', reply: 'Kein Problem, ist vergessen. Womit kann ich dir helfen?' };
    }

    // Beleidigungen abfangen, bevor sie in einem Flow als Slot-Wert landen.
    if (INSULT_RE.test(n)) {
      const c = bumpInsult(uid, sid);
      return { intent: 'insult', reply: c >= 5 ? INSULT_HARD : INSULT_REPLIES[Math.min(c - 1, INSULT_REPLIES.length - 1)] };
    }

    // Abbruch jederzeit. Bewusst tolerant: vorher war das ein exakter Wortvergleich, "vergiss es"
    // brach ab, "ach vergiss es" und "vergiss es!" wurden zur Bezeichnung einer echten Buchung.
    if (flow && /\b(abbrechen|abbruch|abbrich|stop|stopp|vergiss (es|das|den|die)|doch nicht|lass (mal|es|gut sein|stecken)|will (das|ich) (doch )?nicht|nicht eintragen|kein bock mehr|quatsch|egal)\b/.test(n)) {
      flows.delete(key);
      return { intent: 'cancel', reply: 'Alles klar, abgebrochen. Ich habe nichts eingetragen.' };
    }

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

    // Antwort auf eine eigene Rueckfrage. Muss frueh kommen: "birkenbeul" ist fuer jede andere
    // Regel sinnloser Text, aber als Antwort auf "Nenn mir eine Stadt" voellig richtig.
    const asked = takeAsk(uid, sid);

    // Antwort auf eine Lebensmittel-Auswahl. Wird gegen die gemerkte Liste aufgeloest, damit ein
    // Klick nicht erneut in derselben Rueckfrage landet.
    if (asked && asked.kind === 'foodpick' && Array.isArray(asked.opts)) {
      const hit = asked.opts.find(c => foldTxt((c.name + (c.brand ? ' (' + c.brand + ')' : '')).slice(0, 42) + ' · ' + c.kcal + ' kcal') === foldTxt(t))
        || asked.opts.find(c => foldTxt(t).indexOf(foldTxt(c.name)) >= 0 && (!c.brand || foldTxt(t).indexOf(foldTxt(c.brand)) >= 0));
      if (hit) {
        rememberFood(uid, sid, hit.name, hit.kcal);
        return {
          intent: 'food_info',
          reply: `${hit.name}${hit.brand ? ' (' + hit.brand + ')' : ''}: ${hit.kcal} kcal pro 100 g, ${hit.protein} g Eiweiß, ${hit.carbs} g Kohlenhydrate, ${hit.fat} g Fett.`,
          quicks: [{ label: 'Ins Tagebuch', send: 'Essen eintragen: ' + hit.name }],
          sources: [{ kind: 'food', label: 'Lebensmittel-Datenbank' }],
        };
      }
    }

    if (asked === 'city' && t.length >= 2 && t.length <= 60 && !/^(nein|ne|nö|egal|weiss nicht|weiß nicht|abbrechen)$/.test(low)) {
      const city = t.replace(/^(in|aus|für|fuer)\s+/i, '').replace(/[?.!]/g, '').trim();
      const g = await geocode(city).catch(() => null);
      if (!g) {
        // NICHT erneut fragen: sonst wird jede Folgenachricht als Ortsname gedeutet und man
        // kommt nie wieder raus ("mein chef nervt" -> "finde ich nicht").
        return { intent: 'weather', reply: `"${city}" finde ich als Ort leider nicht. Frag mich gern nochmal mit "Wetter in <Stadt>", oder sag mir, was du sonst brauchst.` };
      }
      const w = await weatherFor(g.lat, g.lon, g.city).catch(() => null);
      return { intent: 'weather', reply: w ? `In ${w.city || g.city} sind es gerade ${w.temp} Grad, ${w.desc}, Wind ${w.wind} km/h.` : 'Das Wetter konnte ich gerade nicht abrufen.' };
    }

    // Smalltalk ZUERST, damit Plauderei nicht in die Wikipedia-Suche abrutscht.
    if (/wie (geht|gehts|geht's|läuft)|alles (gut|klar) bei dir|wie ist dein tag|was geht\b/.test(low)) {
      return { intent: 'smalltalk', reply: 'Mir geht es gut, danke der Nachfrage. Und dir? Ich bin bereit, wenn du etwas brauchst: App-Hilfe, Nährwerte, deine Zahlen oder etwas eintragen.' };
    }
    // Bin ich eine echte KI? Wird oft als Nachfrage gestellt, deshalb tolerant und ehrlich.
    if (/\b(echte|richtige|wirkliche)?\s*(ki|ai|kuenstliche intelligenz|sprachmodell|chatgpt|gpt|llm)\b/.test(n)
        || /\b(bist|biste|bist du)\b[^.?!]{0,15}\b(echt|real|ein mensch|mensch|roboter|programm)\b/.test(n)) {
      return { intent: 'smalltalk', reply: 'Ehrlich: nein. Ich bin kein großes Sprachmodell wie ChatGPT, sondern regelbasiert. Ich erkenne Muster in dem, was du schreibst, und antworte mit dem, was ich zu deiner App, zu Nährwerten und deinen Daten weiß. Dafür läuft alles ohne fremde KI-Dienste, deine Daten bleiben auf deinem Server.' };
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
    if (/\bwitz\b|\bwitze\b|scherz|mach mich lachen|erzaehl[^.?!]{0,15}witz|bring mich zum lachen|was lustiges/.test(n)) {
      return { intent: 'joke', reply: nextJoke(uid, sid), quicks: [{ label: 'Noch einen', send: 'noch einen witz' }] };
    }
    if (jokeIdx.get(uid + ':' + sid) && /^(noch (einen|einer|mal)|nochmal|mehr|weiter|und noch einen|noch)\b/.test(n)) {
      return { intent: 'joke', reply: nextJoke(uid, sid), quicks: [{ label: 'Noch einen', send: 'noch einen witz' }] };
    }
    // Persoenliche Frage: muss VOR die Wikipedia-Suche, sonst landet "was weisst du ueber mich" dort.
    if (/was weisst du (ueber|von) mich|was weisst du ueber mich|kennst du mich|was hast du dir (ueber mich )?gemerkt|was weisst du von mir/.test(n)) {
      const mem = await memorySummary(uid);
      return { intent: 'memory', reply: mem
        ? `Ich habe mir das hier von dir gemerkt: ${mem}. Du kannst das jederzeit in den Einstellungen löschen.`
        : 'Bisher habe ich mir nichts von dir gemerkt. Wenn du mir etwas erzählst, zum Beispiel "Ich bin Vegetarier" oder "Ich wohne in Köln", behalte ich das für unsere Gespräche.' };
    }
    // Hunger/Durst: in einer Ernaehrungs-App das Naheliegendste ueberhaupt, fiel vorher durch.
    if (/\b(hab|habe|bin)\s*(grad |gerade |so |voll |mega |echt )*(hunger|hungrig|kohldampf)\b|\bhunger\b|\bwas essen\b|\bwas soll ich essen\b|\bhaette lust auf was\b/.test(n)) {
      const d = await dataAnswer(uid, 'kcal_today').catch(() => '');
      return { intent: 'domain', reply: `${d} Wenn du magst, schau in deinen Ernährungsplan, da steht schon, was für heute vorgesehen ist. Oder sag mir ein Lebensmittel, dann sage ich dir die Nährwerte.`, quicks: [{ label: 'Was steht im Plan?', send: 'Wie funktioniert der Ernährungsplan?' }, { label: 'Essen eintragen', send: 'Ich möchte Essen eintragen' }] };
    }
    if (/\b(hab|habe|bin)\s*(grad |gerade |so )*(durst|durstig)\b/.test(n)) {
      return { intent: 'domain', reply: 'Trink am besten ein Glas Wasser. Faustregel sind etwa 30 bis 35 ml pro kg Körpergewicht am Tag, bei Hitze oder Sport mehr. Dein Wasserglas-Zähler ist im Ernährungsbereich.' };
    }

    // Lockere Absagen: "nein danke kb", "keine lust", "passt schon"
    if (/^(nein|ne|noe|nö|nee)?\s*(danke|dank)?\s*(kb|kein bock|keine lust|passt schon|schon gut|alles gut|lass mal|nichts)\s*$/.test(n) || /^(kb|nix|nichts|passt)$/.test(n)) {
      return { intent: 'smalltalk', reply: 'Alles klar, kein Ding. Ich bin da, falls dir doch noch was einfällt.' };
    }

    // Gefuehle: erst zuhoeren, nicht mit einem Support-Ticket antworten.
    if (SAD_RE.test(n)) {
      return { intent: 'empathy', reply: SAD_REPLIES[Math.floor(Math.random() * SAD_REPLIES.length)] };
    }
    if (/\b(bin (gestresst|im stress)|zu viel stress|keine zeit|alles gleichzeitig|chaos im kopf)\b/.test(n)) {
      return { intent: 'empathy', reply: STRESS_REPLY, quicks: [{ label: 'Was steht an?', send: 'Welche Termine habe ich?' }, { label: 'Aufgabe eintragen', send: 'Ich möchte eine Aufgabe eintragen' }] };
    }
    if (/\b(mir gehts? gut|geht mir gut|bin gluecklich|bin froh|super drauf|bestens|alles super|alles gut)\b/.test(n)) {
      return { intent: 'smalltalk', reply: 'Das freut mich zu hören. Wenn du etwas brauchst, sag Bescheid.' };
    }

    // "kannst du mir helfen" ist eine Einladung, keine Wissensfrage.
    if (/^(kannst|koenntest) du (mir )?(bitte )?(irgendwie )?helfen|^hilf mir|^ich brauche hilfe|^brauche hilfe/.test(n)) {
      return { intent: 'smalltalk', reply: 'Klar, gern. Sag mir einfach, worum es geht: App-Hilfe, Nährwerte, deine Kalorien oder Finanzen, oder ich trage dir etwas ein.', quicks: [{ label: 'Kalorien heute', send: 'Wie viele Kalorien habe ich heute?' }, { label: 'Was kannst du?', send: 'Was kannst du alles?' }] };
    }

    // Eigenes Kalorienziel ("wie viel darf ich essen") ist eine Datenfrage, keine Lebensmittelsuche.
    if (/\b(wie viel|wieviel)[^.?!]{0,20}\b(darf|soll|kann|muss) ich\b[^.?!]{0,15}\b(essen|zu mir nehmen)\b|\bmein (kalorien)?(ziel|bedarf)\b|\bwie viele kalorien (darf|soll|brauche) ich\b/.test(n)) {
      return { intent: 'data', reply: await dataAnswer(uid, 'kcal_today'), quicks: [{ label: 'Essen eintragen', send: 'Ich möchte Essen eintragen' }] };
    }

    // Rueckfrage auf die letzte Naehrwert-Antwort: "und n apfel", "und banane?"
    if (lastFood.get(uid + ':' + sid) && /^(und|was ist mit|wie sieht.s aus mit)\s+(ne |n |eine |ein |der |die |das )?([a-zäöüß][a-zäöüß \-]{2,28})\??$/.test(low)) {
      const m2 = low.match(/^(?:und|was ist mit|wie sieht.s aus mit)\s+(?:ne |n |eine |ein |der |die |das )?([a-zäöüß][a-zäöüß \-]{2,28})\??$/);
      const cands2 = m2 ? await foodCandidates(m2[1].trim(), 4) : [];
      if (cands2.length) {
        const t2 = cands2[0];
        rememberFood(uid, sid, t2.name, t2.kcal);
        return { intent: 'food_info', reply: `${t2.name}${t2.brand ? ' (' + t2.brand + ')' : ''}: ${t2.kcal} kcal pro 100 g, ${t2.protein} g Eiweiß, ${t2.carbs} g Kohlenhydrate, ${t2.fat} g Fett.`, sources: [{ kind: 'food', label: 'Lebensmittel-Datenbank' }] };
      }
    }

    // Rueckbezug auf die letzte Naehrwert-Antwort ("und ist das gesund?", "wie viel ist das?")
    const lf = lastFood.get(uid + ':' + sid);
    if (lf && /^(und |aber )?(ist|sind|waere|ist denn)?\s*(das|es|die|der|sowas)\b[^.?!]{0,20}\b(gesund|ungesund|schlimm|ok|okay|viel|zu viel|fett|fettig)\b/.test(n)) {
      const viel = lf.kcal >= 400 ? 'Das ist ziemlich energiedicht' : lf.kcal >= 200 ? 'Das liegt im Mittelfeld' : 'Das ist eher kalorienarm';
      return { intent: 'domain', reply: `${viel}: ${lf.name} hat ${lf.kcal} kcal pro 100 g. Ob das für dich passt, hängt von der Menge und deinem restlichen Tag ab, nicht vom Lebensmittel allein. Ich bin keine Ernährungsberatung, aber die Zahlen helfen dir beim Einordnen.`, quicks: [{ label: 'Kalorien heute', send: 'Wie viele Kalorien habe ich heute?' }, { label: 'Eintragen', send: 'Essen eintragen: ' + lf.name }] };
    }

    // Eigenes Glossar VOR Hilfe und Wikipedia: Kernbegriffe beantwortet die App selbst.
    for (const g of GLOSSAR) { if (g.re.test(n)) return { intent: 'domain', reply: g.a }; }

    // Domaenenfragen (Abnehmen, Fitness, Eiweiss, Trinken, "ist X gesund")
    for (const d of DOMAIN) {
      if (d.re.test(n)) return { intent: 'domain', reply: d.reply, quicks: d.quicks };
    }

    // Begrüßung
    if (/^(hi+|hallo|hey+|moin|servus|grü(ß|ss)|guten (morgen|tag|abend)|na\b|yo\b|hallöchen)/.test(low)) {
      return { intent: 'greet', reply: `Hallo! Ich bin ${NAMES[settings.assistant === 'man' ? 'man' : 'woman']}. Ich helfe dir bei der App, bei Nährwerten, deinen Daten und kann Sachen für dich eintragen. Was brauchst du?`, quicks: [{ label: 'Kalorien heute', send: 'Wie viele Kalorien habe ich heute?' }, { label: 'Ausgabe eintragen', send: 'Ich möchte eine Ausgabe eintragen' }, { label: 'Hilfe', send: 'Wie funktioniert der Ernährungsplan?' }] };
    }

    // Letzte Buchung loeschen. Fehlte komplett: wer sich vertippt hatte, kam nicht zurueck, und
    // jeder Rettungsversuch ("korrigier die letzte buchung auf 15 euro") legte eine NEUE Buchung
    // an. Muss vor die Aktions-Weiche, sonst faengt die das "buchung" ab.
    if (/\b(loesch|entfern|rueckgaengig|storrnier|stornier|zurueck ?nehmen)\w*\b[^.?!]{0,25}\b(buchung|ausgabe|einnahme|eintrag|transaktion)\b/.test(n)
        || /\b(die )?letzte (buchung|ausgabe|einnahme|eintrag)\b[^.?!]{0,20}\b(loesch|weg|entfern|rueckgaengig|falsch|stornier)\w*\b/.test(n)
        || /\b(hab|habe) mich vertippt\b[^.?!]{0,25}\b(buchung|ausgabe|einnahme)\b/.test(n)
        || /\b(korrigier|aender)\w*\b[^.?!]{0,20}\b(letzte|die letzte)\b[^.?!]{0,12}\b(buchung|ausgabe|einnahme)\b/.test(n)) {
      const [[last]] = await pool.execute(
        'SELECT id, amount, name, date FROM transactions WHERE user_id=? AND planned=0 ORDER BY id DESC LIMIT 1', [uid]).catch(() => [[null]]);
      if (!last) return { intent: 'data', reply: 'Ich finde keine Buchung, die ich löschen könnte. Dein Finanzbuch ist leer.' };
      startFlow(uid, sid, 'delTx');
      const f = flows.get(key);
      f.data.id = last.id; f.awaitConfirm = true;
      return { intent: 'flow_confirm',
        reply: `Deine letzte Buchung ist ${fmtEur(Math.abs(last.amount))} ${Number(last.amount) < 0 ? 'Ausgabe' : 'Einnahme'}${last.name ? ' (' + last.name + ')' : ''} vom ${String(last.date).slice(0,10)}. Soll ich die löschen?`,
        quicks: [{ label: 'Ja, löschen', send: 'ja' }, { label: 'Abbrechen', send: 'abbrechen' }] };
    }

    // Lesen vor Schreiben pruefen: "zeig mir meine ausgaben" enthaelt "ausgabe" und startete
    // vorher den Buchungsdialog ("Wie hoch ist der Betrag?"). Der Nutzer wollte lesen.
    const leseWunsch = /^(zeig|zeige|liste|welche|was (sind|waren|habe|hab)|wie viele?|wieviel|hab ich|habe ich|gibt es|wo |meine |mein )/.test(n)
      || /\b(anzeigen|auflisten|uebersicht|zusammenfassung|liste mir)\b/.test(n);
    if (leseWunsch && /(ausgabe|einnahme|buchung|transaktion|umsatz)/.test(n) && !/\b(neue|neuen|neues)\b/.test(n)) {
      return { intent: 'data', reply: await dataAnswer(uid, 'balance') + ' Die einzelnen Buchungen siehst du im Finanzbuch unter Finanzen.', quicks: [{ label: 'Ausgabe eintragen', send: 'Ausgabe eintragen' }] };
    }

    // Aktionen (Eintragen/Erledigen). Das blosse Wort "ausgabe" reicht NICHT mehr, sonst startet
    // "meine ausgaben diesen monat" den Buchungsdialog. Es braucht ein Verb, das blosse Nomen
    // allein, oder einen Betrag mit Ausgabe-Verb ("ich hab 30 euro fuer kaffee bezahlt").
    const aktionVerb = /(trag|eintragen|buch|erfass|notier|leg an|anlegen|hinzufüg)/.test(low);
    const nurNomen = /^(eine? )?(ausgabe|einnahme)$/.test(n);
    const geldVerb = /\b(ausgegeben|bezahlt|gekauft|gekostet|bekommen|erhalten|verdient|ueberwiesen)\b/.test(n);
    if (aktionVerb || nurNomen || (parseAmount(low) != null && geldVerb)) {
      if (/gewicht|wiege|gewogen|kg\b/.test(low)) { startFlow(uid, sid, 'weight'); const n = parseAmount(low); if (n && n >= 20 && n <= 400) { const f = flows.get(key); f.data.kg = n; f.step = 1; f.awaitConfirm = true; return { intent: 'flow', reply: await confirmSummary(uid, f), quicks: [{ label: 'Ja', send: 'ja' }, { label: 'Abbrechen', send: 'abbrechen' }] }; } return { intent: 'flow', reply: FLOW_DEFS.weight.slots[0].ask }; }
      if (/aufgabe|todo|to-do|erledig/.test(low)) { startFlow(uid, sid, 'todo'); return { intent: 'flow', reply: FLOW_DEFS.todo.slots[0].ask }; }
      if (/termin|appointment|kalender/.test(low)) { startFlow(uid, sid, 'appointment'); return { intent: 'flow', reply: FLOW_DEFS.appointment.slots[0].ask }; }
      if (/gegessen|essen|kalorien.*(trag|eintr)|mahlzeit|food|tagebuch/.test(low)) {
        const f = startFlow(uid, sid, 'food');
        // "Essen eintragen: Nutella" -> Namen gleich uebernehmen, statt nochmal zu fragen
        const pre = t.match(/(?:essen eintragen|tagebuch)\s*[:\-]\s*(.{2,60})$/i);
        if (pre && f) { const v = FLOW_DEFS.food.slots[0].parse(pre[1].trim()); if (v !== null) { f.data[FLOW_DEFS.food.slots[0].key] = v; f.step = 1; return { intent: 'flow', reply: FLOW_DEFS.food.slots[1].ask }; } }
        return { intent: 'flow', reply: FLOW_DEFS.food.slots[0].ask };
      }
      // Finanz-Buchung NUR mit Finanz-Hinweis. Sonst landete der eigene Knopf des Bots
      // ("Ich möchte Nutella eintragen") in der Buchung und hielt den Nutzer dort fest.
      const finHint = /(ausgabe|einnahme|buchung|euro|eur|geld|gekauft|bezahlt|gekostet|gehalt|lohn|ueberweis|rechnung|konto|finanz)/.test(n) || /€/.test(t);
      if (!finHint) {
        return { intent: 'ask', reply: 'Klar. Was möchtest du eintragen?', quicks: [
          { label: 'Essen', send: 'Essen eintragen' },
          { label: 'Ausgabe', send: 'Ausgabe eintragen' },
          { label: 'Gewicht', send: 'Gewicht eintragen' },
          { label: 'Aufgabe', send: 'Aufgabe eintragen' },
          { label: 'Termin', send: 'Termin eintragen' },
        ] };
      }
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
    // Bewusst weit: der Bot kannte die Zahl und bot trotzdem ein Support-Ticket an, sobald ein
    // Wort fehlte ("wie viel geld hab ich noch" ging, "wie viel hab ich noch" nicht).
    if (/kontostand|kontostnad|saldo|wie viel geld|finanzen|budget uebrig/.test(n)
        || /\b(wie viel|wieviel)\b[^.?!]{0,25}\b(ausgegeben|ausgeben|verbraten|raus|weg)\b/.test(n)
        || /\b(wie viel|wieviel)\b[^.?!]{0,15}\b(hab|habe) ich\b[^.?!]{0,12}(noch|uebrig|insgesamt|drauf)?\s*[.?!]*$/.test(n)
        || /\bbin ich im (minus|plus)\b|\bsteh ich im (minus|plus)\b|\bwie steht (es|es denn) um meine finanzen\b/.test(n)) {
      const txt = await dataAnswer(uid, 'balance');
      const minusFrage = /\bim (minus|plus)\b/.test(n);
      if (minusFrage) {
        const [[r]] = await pool.execute('SELECT COALESCE(SUM(amount),0) bal FROM transactions WHERE user_id=? AND planned=0', [uid]).catch(() => [[{ bal: 0 }]]);
        const b = Number(r.bal) || 0;
        return { intent: 'data', reply: (b < 0 ? 'Ja, du bist im Minus. ' : b > 0 ? 'Nein, du bist im Plus. ' : 'Du stehst genau bei null. ') + txt };
      }
      return { intent: 'data', reply: txt };
    }
    if (/offene (aufgaben|todos|to-dos)|wie viele (aufgaben|todos)/.test(low)) return { intent: 'data', reply: await dataAnswer(uid, 'todos') };
    if (/(nächste[rn]?|welche) termine?|was steht an|termine/.test(low)) return { intent: 'data', reply: await dataAnswer(uid, 'appts') };

    // Wetter (Open-Meteo). Explizit genannte Stadt geht immer; eigener Standort nur mit Datenschutz-Schalter.
    if (/wetter|temperatur|regnet|wie warm|grad draußen/.test(low)) {
      let lat = null, lon = null, city = null;
      const cm = t.match(/in\s+([A-Za-zÄÖÜäöüß .-]{2,40})/);
      if (cm) { const g = await geocode(cm[1].trim()); if (g) { lat = g.lat; lon = g.lon; city = g.city; } }
      if (lat == null && settings.allow_location && settings.home_lat != null) { lat = settings.home_lat; lon = settings.home_lon; city = settings.home_city; }
      if (lat == null) {
        setAsk(uid, sid, 'city');
        return { intent: 'weather', reply: settings.allow_location
          ? 'Ich habe noch keinen Standort hinterlegt. In welcher Stadt bist du?'
          : 'In welcher Stadt? Schreib mir einfach den Ort, dann schaue ich nach. (Deinen Standort dauerhaft hinterlegen kannst du in den Einstellungen unter Datenschutz.)' };
      }
      const w = await weatherFor(lat, lon, city).catch(() => null);
      return { intent: 'weather', reply: w ? `In ${w.city || 'deiner Region'} sind es gerade ${w.temp} Grad, ${w.desc}, Wind ${w.wind} km/h.` : 'Das Wetter konnte ich gerade nicht abrufen.' };
    }

    // Nährwert-Frage ("wie viel kcal hat nutella")
    if (/(wie viele?|wieviel).*(kalorien|kcal|eiweiss|protein|fett|kohlenhydrate|naehrwerte?)/.test(n) || /(kalorien|kcal|naehrwerte?)\s+(von|fuer|hat|in)/.test(n) || /(how many|how much).*(calories|protein|carbs|fat)/.test(n)) {
      let m = low.replace(/[?.!,]/g, ' ').replace(/^.*\b(hat|von|für|fuer|in|does|of)\s+/, '').replace(/\b(have|has|got|hat)\b/g, ' ').replace(/\s+/g, ' ').trim();
      if (!m || m.length < 2) m = low.replace(/(wie viele?|wieviel|kalorien|kcal|nährwerte?|naehrwerte?|hat|eine[nr]?|ein|der|die|das|how many|how much|calories|protein|carbs|fat|does|have)/g, ' ').replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();
      const cands = await foodCandidates(m, 6);
      if (!cands.length) return { intent: 'food_info', reply: 'Dazu habe ich in der Lebensmittel-Datenbank nichts gefunden. Formulier es vielleicht anders.' };

      // Nachfragen, aber NUR wenn es einen Unterschied macht. "Nutella" und "Nutella to go" haben
      // andere Werte, und bei "Milch" wurde vorher stumm irgendeine Marke gewaehlt.
      const label = (c) => (c.name + (c.brand ? ' (' + c.brand + ')' : '')).slice(0, 42);
      // Die Datenbank hat Dubletten ("Nutella (Nutella)" und "Nutella (nutella)") und Eintraege
      // ohne Marke, die sich nur um 1 kcal unterscheiden. Beides taugt nicht als Auswahl.
      const seen = new Set();
      const uniq = cands.filter(c => {
        const k = foldTxt(label(c)) + '|' + Math.round(c.kcal / 10);
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
      const kc = uniq.map(c => c.kcal);
      const spread = kc.length > 1 ? Math.max(...kc) - Math.min(...kc) : 0;
      if (uniq.length >= 2 && spread >= 25) {
        const opts = uniq.slice(0, 5);
        // Auswahl merken, damit der Klick eindeutig aufgeloest wird. Ohne das landet "Banane"
        // wieder in derselben Rueckfrage: Endlosschleife.
        setAsk(uid, sid, { kind: 'foodpick', opts });
        return {
          intent: 'food_choice',
          reply: `Davon habe ich mehrere, und die Werte gehen deutlich auseinander (${Math.min(...kc)} bis ${Math.max(...kc)} kcal pro 100 g). Welches meinst du?`,
          quicks: opts.map((c, i) => ({ label: label(c) + ' · ' + c.kcal + ' kcal', send: label(c) + ' · ' + c.kcal + ' kcal' })),
          sources: [{ kind: 'food', label: 'Lebensmittel-Datenbank' }],
        };
      }

      const top = cands[0];
      rememberFood(uid, sid, top.name, top.kcal);
      const others = cands.slice(1, 5).filter(c => label(c).toLowerCase() !== label(top).toLowerCase());
      return {
        intent: 'food_info',
        reply: `${top.name}${top.brand ? ' (' + top.brand + ')' : ''}: ${top.kcal} kcal pro 100 g, ${top.protein} g Eiweiß, ${top.carbs} g Kohlenhydrate, ${top.fat} g Fett.`,
        quicks: others.map(c => ({ label: label(c) + ' · ' + c.kcal + ' kcal', send: 'Nährwerte von ' + c.name + (c.brand ? ' ' + c.brand : '') })).concat([{ label: 'Ins Tagebuch', send: 'Essen eintragen: ' + top.name }]),
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
    // Zwei Bremsen, weil die Suche sonst absurd antwortet: "wie lang muss ich denn machen" lieferte
    // einen Splatterfilm, "was is mit sport" den Lexus IS.
    const chatty = /\b(ich|mir|mich|mein|meine|du|dir|dich|dein|wir|uns|denn|mal|eigentlich|bitte|danke|ok|okay)\b/.test(n);
    const knowledge = !chatty
      && (/^(wer |was |wann |wo |warum |wieso |welche|wie viel|wie hoch|wie lang|wie funktioniert|erklär|definiere)/.test(low)
        || /\b(bedeutet|hauptstadt von|geboren|gestorben|erfinder von|geschichte von)\b/.test(low));
    if (knowledge) {
      const wiki = await wikiSearch(t).catch(() => null);
      // Zwei Filter. Der Wort-Treffer allein reichte nicht: "Zucker, Zucker! ist eine Filmsatire"
      // enthaelt "Zucker" und rutschte durch. Begriffsklaerungen sind nie eine Antwort, und ein
      // Film/Lied/Roman ist auf eine Sachfrage praktisch immer der falsche Treffer.
      const passt = wiki && wiki.text && qWords.some((w) => fold(wiki.text.slice(0, 160)).indexOf(w) >= 0);
      const kopf = wiki && wiki.text ? wiki.text.slice(0, 200) : '';
      const mist = /begriffskl|steht f(ü|ue)r:|bezeichnet:|ist der name|kann sich beziehen|\b(film|spielfilm|filmsatire|kom(ö|oe)die|fernsehserie|lied|song|album|roman|musical|band|einheit\)|zeitschrift|magazin|sendung)\b/i.test(kopf);
      if (passt && !mist) return { intent: 'wiki', reply: wiki.text };
    }

    // Aussagen ueber sich selbst bestaetigen. scanMemory hat sie oben schon gespeichert, ohne
    // diesen Zweig antwortete der Bot auf "ich bin Vegetarier" mit "das verstehe ich nicht".
    if (/\b(ich bin|ich heisse|mein name ist|ich wohne|ich lebe|ich mag kein|ich esse kein|ich vertrage kein|ich spare|mein ziel|ich will|ich moechte)\b/.test(n)
        && /\b(vegan|veganer|veganerin|vegetarier|vegetarierin|vegetarisch|wohne in|lebe in|heisse|name ist|mag kein|esse kein|vertrage kein|spare (auf|fuer)|\d{3,5}\s*(kcal|kalorien))\b/.test(n)) {
      const mem = await memorySummary(uid);
      return { intent: 'memory', reply: mem
        ? `Alles klar, das merke ich mir. Aktuell weiß ich das über dich: ${mem}.`
        : 'Alles klar, das merke ich mir für unsere Gespräche.' };
    }

    // Fallback gestaffelt: nicht auf jeden Murks ein Support-Ticket anbieten.
    const words = (n.match(/[a-z0-9]+/g) || []);
    const letters = (n.match(/[a-z]/g) || []).length;

    // Nur Emojis, Satzzeichen oder Zahlen
    if (!letters) return { intent: 'unclear', reply: 'Damit kann ich nichts anfangen. Schreib mir ruhig in ganzen Worten, was du brauchst.' };

    // Kurze Bestaetigungen und Fuellwoerter: nicht als Frage behandeln
    // Kurze Bestaetigungen, auch mehrteilig ("ok danke", "ok cool", "alles klar dann")
    if (/^(ok|okay|oke|jo|jap|joa|aha|achso|hm+|mhm|na ja|naja|und|halt|eben|ach|so|alles klar|verstehe|gut|schon gut|cool|nice|top|super|perfekt|passt|geil|krass|stimmt|klar)([ ,]+(ok|okay|danke|dank dir|cool|nice|top|super|gut|klar|dann|schon|mal|denn))*[.!]*$/.test(n)) {
      return { intent: 'smalltalk', reply: 'Alles klar. Sag einfach, wenn du etwas brauchst.' };
    }
    if (/^(langweilig|mir ist langweilig|und jetzt|was jetzt|weiter)$/.test(n)) {
      return { intent: 'smalltalk', reply: 'Dann lass uns was tun. Ich kann dir deine Zahlen zeigen, Nährwerte nachschlagen oder etwas eintragen. Im Spiele-Bereich gibt es auch Quiz und Training.', quicks: [{ label: 'Kalorien heute', send: 'Wie viele Kalorien habe ich heute?' }, { label: 'Nährwerte', send: 'Wie viele Kalorien hat Nutella?' }] };
    }

    // Kauderwelsch: keine erkennbaren Woerter (nur Buchstabensalat ohne Vokalstruktur)
    const gibberish = words.length <= 3 && words.every(w => w.length < 3 || !/[aeiou]/.test(w));
    if (gibberish) return { intent: 'unclear', reply: 'Das habe ich nicht verstanden. Kannst du es anders formulieren?' };

    // Echte, aber unbeantwortete Frage: hier ist ein Ticket sinnvoll
    const isQuestion = /\?$/.test(t) || /^(wer|was|wann|wo|warum|wieso|weshalb|welche|wie|kann|kannst|hast|gibt|ist|sind|darf|soll|muss)\b/.test(n);
    if (isQuestion) {
      return { intent: 'unknown', reply: 'Das weiß ich leider nicht. Ich kenne mich mit der App, Nährwerten, deinen Zahlen und Terminen aus. Wenn es um die App geht, kann ich ein Ticket an den Support anlegen, dann schaut ein Mensch drauf.', quicks: [{ label: 'Ja, Ticket', send: 'Ich möchte ein Support-Ticket erstellen' }, { label: 'Nein danke', send: 'nein danke' }] };
    }
    return { intent: 'unclear', reply: 'Da bin ich raus, das habe ich nicht verstanden. Frag mich gern etwas zur App, zu Nährwerten oder zu deinen Zahlen.', quicks: [{ label: 'Was kannst du?', send: 'Was kannst du alles?' }] };
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
      return res.json({ session_id: sid, reply: applyTone(reply, settings.bot_tone, 'flow'), intent: 'flow', message_id: tid, tts: { classification: tcls.classification, cloudEligible: false, localEligible: ttsPolicy.isLocalTtsAllowed(tcls.classification, tcls.forbidden), policyVersion: tcls.policyVersion } });
    }
    const out = await route(req.uid, sid, text, settings);
    const meta = ttsMetaFor(out.intent);
    const cls = ttsPolicy.classifyTtsContent(meta, out.reply);
    const botMsgId = await saveChat(sid, req.uid, 'bot', out.reply, out.intent, meta);
    res.json({ session_id: sid, reply: applyTone(out.reply, settings.bot_tone, out.intent), intent: out.intent, quicks: out.quicks || [], sources: out.sources || [], voice: NAMES[settings.assistant === 'man' ? 'man' : 'woman'], message_id: botMsgId, tts: { classification: cls.classification, cloudEligible: (cls.classification === 'PUBLIC' || cls.classification === 'PRIVATE'), localEligible: ttsPolicy.isLocalTtsAllowed(cls.classification, cls.forbidden), policyVersion: cls.policyVersion } });
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
