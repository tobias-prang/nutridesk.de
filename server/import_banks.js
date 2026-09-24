// Einmaliger Import der FinTS-Institutsliste in die Tabelle `banks`.
// Quelle: willuhn/hbci4java blz.properties (offiziell abgeleitete, gepflegte Liste).
// Format je Zeile:  BLZ=Name|Ort|BIC|Code|HBCI-DNS|PINTAN-URL|Ver|Ver|
require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2/promise');

// Gezielte Korrekturen fuer Institute, die im Mirror veraltet sind.
// 57351030: aktueller Name "Sparkasse Westerwald-Sieg", FinTS-Endpunkt auf rp1.
const OVERRIDES = {
  '57351030': { name: 'Sparkasse Westerwald-Sieg', city: 'Altenkirchen (Westerwald)', bic: 'MALADE51AKI', url: 'https://banking-rp1.s-fints-pt-rp.de/fints30' },
};

function parse(file) {
  // Die blz.properties ist ISO-8859-1 (Java-Konvention), sonst werden Umlaute zu Mojibake.
  const txt = fs.readFileSync(file, 'latin1');
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const blz = line.slice(0, eq).trim();
    if (!/^\d{6,12}$/.test(blz)) continue;
    const parts = line.slice(eq + 1).split('|');
    let name = (parts[0] || '').trim();
    let city = (parts[1] || '').trim();
    let bic = (parts[2] || '').trim();
    let url = (parts[5] || '').trim();
    if (!/^https?:\/\//i.test(url)) url = '';
    // Alte genossenschaftliche Hosts (Fiducia/GAD) sind abgeschaltet und loesen nicht mehr auf.
    // Sie wurden bei Atruvia zusammengefuehrt, gleicher Pfad /cgi-bin/hbciservlet.
    if (/\b(fiducia\.de|gad\.de)\b/i.test(url)) url = 'https://fints2.atruvia.de/cgi-bin/hbciservlet';
    const ov = OVERRIDES[blz];
    if (ov) { name = ov.name; city = ov.city; bic = ov.bic; url = ov.url; }
    if (!name) continue;
    out.push([blz, name.slice(0, 160), bic ? bic.slice(0, 16) : null, url ? url.slice(0, 255) : null, city ? city.slice(0, 120) : null]);
  }
  return out;
}

(async () => {
  const rows = parse('/tmp/willuhn.properties');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASS, database: process.env.DB_NAME, multipleStatements: false, charset: 'utf8mb4',
  });
  await conn.execute('DELETE FROM banks');
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const ph = chunk.map(() => '(?,?,?,?,?)').join(',');
    const flat = [];
    for (const r of chunk) flat.push(...r);
    await conn.query('INSERT INTO banks (blz, name, bic, fints_url, city) VALUES ' + ph, flat);
    n += chunk.length;
  }
  const [[c]] = await conn.query('SELECT COUNT(*) c FROM banks');
  const [[u]] = await conn.query('SELECT COUNT(*) c FROM banks WHERE fints_url IS NOT NULL');
  const [[ref]] = await conn.query('SELECT name, fints_url FROM banks WHERE blz = ?', ['57351030']);
  console.log('inserted=' + n + ' total=' + c.c + ' with_url=' + u.c);
  console.log('ref 57351030 => ' + JSON.stringify(ref));
  await conn.end();
})().catch(e => { console.error(e); process.exit(1); });
