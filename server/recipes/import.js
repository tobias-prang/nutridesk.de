// Importiert die von Hand geschriebenen Rezepte in recipes + recipe_ingredients.
// Nährwerte je Portion und Tags werden deterministisch aus der Pantry berechnet.
//
//   node recipes/import.js --check   -> nur validieren (fehlende Keys, Nährwert-Stichprobe)
//   node recipes/import.js           -> in die Datenbank schreiben (löscht vorher source='system')
//
// Muss aus /opt/nutridesk-api laufen (mysql2, dotenv, .env liegen dort).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { P } = require('./pantry');

const DIR = __dirname;
const files = fs.readdirSync(DIR).filter(f => /^r\d.*\.js$/.test(f)).sort();
let recipes = [];
for (const f of files) {
  const arr = require(path.join(DIR, f));
  if (!Array.isArray(arr)) { console.error('KEIN Array:', f); process.exit(1); }
  arr.forEach(r => r.__file = f);
  recipes = recipes.concat(arr);
}
console.log(`${files.length} Dateien, ${recipes.length} Rezepte geladen.`);

// ---- Zutaten-Kategorie (für die Einkaufsliste) + grobe Preisschätzung ----
const GRAINS = new Set(['reis','vollkornreis','basmatireis','nudeln','vollkornnudeln','spaghetti','penne','fusilli','tagliatelle','gnocchi','tortellini','kartoffeln','suesskartoffel','kartoffelpueree','pommes','quinoa','couscous','bulgur','haferflocken','vollkornbrot','toastbrot','broetchen','wrap','fladenbrot','reiswaffeln','knaeckebrot','polenta','spaetzle','lasagneplatten','mehl','semmelbroesel','griess','muesli','granola','cornflakes','reisnudeln','glasnudeln','naanbrot','burgerbun','pizzateig','brezel','dinkelmehl','kloesse','kichererbsenmehl','panko','filoteig','reispapier','udon','sushireis','tortilla_mais','cornmeal','maniok','kochbanane','buchweizen','yamswurzel']);
const OILS = new Set(['olivenoel','rapsoel','sesamoel','butter','ghee']);
const PLANTPROT = new Set(['tofu','raeuchertofu','räuchertofu','tempeh','seitan','kichererbsen','linsen','rotelinsen','kidneybohnen','schwarzebohnen','weissebohnen','sojaschnetzel','edamame','erbsen','belugalinsen','paneer_tofu','jackfruit','schwarzaugenbohnen','urad']);
const NUTS = new Set(['mandeln','walnuesse','haselnuesse','cashews','erdnuesse','erdnussbutter','mandelmus','chiasamen','leinsamen','sonnenblumenkerne','kuerbiskerne','sesam','pinienkerne','kokosraspel','tahin','kokoschips']);
function catFor(key, it) {
  if (it.spice) return 'Gewürze & Basics';
  if (it.kind === 'meat' || it.kind === 'fish') return 'Fleisch & Fisch';
  if (PLANTPROT.has(key)) return 'Proteine & Hülsenfrüchte';
  if (it.kind === 'egg' || it.kind === 'dairy') return 'Milch & Eier';
  if (OILS.has(key)) return 'Fette & Öle';
  if (NUTS.has(key)) return 'Nüsse & Kerne';
  if (GRAINS.has(key)) return 'Getreide & Basis';
  if (it.kind === 'plant') return 'Obst & Gemüse';
  return 'Sonstiges';
}

// ---- Nährwerte + Tags berechnen ----
function round1(x) { return Math.round(x * 10) / 10; }
function compute(r) {
  let kcal = 0, c = 0, p = 0, f = 0;
  const ings = [];
  const missing = [];
  for (const [key, g] of r.ing) {
    const it = P[key];
    if (!it) { missing.push(key); continue; }
    const k = it.kcal * g / 100, cc = it.c * g / 100, pp = it.p * g / 100, ff = it.f * g / 100;
    kcal += k; c += cc; p += pp; f += ff;
    ings.push({ key, name: it.n, g, kcal: Math.round(k), c: round1(cc), p: round1(pp), f: round1(ff), cat: catFor(key, it), it });
  }
  return { kcal: Math.round(kcal), c: round1(c), p: round1(p), f: round1(f), ings, missing };
}

// Teilwort-Stämme fuer Ausschluss-Tags (Schwein/Pilze/Nuesse; Fisch laeuft ueber kind).
// Substring-Match auf den Zutaten-Key, damit auch Varianten (schinkenwuerfel, kochschinken ...) greifen.
const PORK_STEMS = ['schwein', 'schinken', 'bacon', 'chorizo', 'mettwurst', 'bratwurst', 'kasseler', 'leberkaese', 'speck', 'salami', 'pancetta', 'gyros', 'wiener', 'kabanossi', 'cabanossi', 'krakauer', 'landjaeger'];
const MUSHROOM_STEMS = ['pilz', 'champignon', 'shiitake', 'seitling'];
const NUT_STEMS = ['mandel', 'nuesse', 'erdnuss', 'cashew', 'pistazi', 'pinienkern', 'walnuss', 'haselnuss'];
const hasStem = (keys, stems) => keys.some(k => stems.some(s => k.includes(s)));

// Tags: rein aus den Zutaten + Metadaten abgeleitet
function tagsFor(r, nut) {
  const kinds = nut.ings.map(i => i.it.kind);
  const keys = nut.ings.map(i => i.key);
  const hasMeatFish = kinds.some(k => k === 'meat' || k === 'fish');
  const hasAnimal = kinds.some(k => k === 'meat' || k === 'fish' || k === 'egg' || k === 'dairy' || k === 'honey');
  const hasDairy = kinds.some(k => k === 'dairy');
  const hasGluten = nut.ings.some(i => i.it.glu);
  const hasPricey = nut.ings.some(i => i.it.pri);
  const hasFish = kinds.some(k => k === 'fish');
  const hasPork = hasStem(keys, PORK_STEMS);
  const hasMushroom = hasStem(keys, MUSHROOM_STEMS);
  const hasNuts = hasStem(keys, NUT_STEMS);
  const t = [];
  if (!hasMeatFish) t.push('vegetarisch');
  if (!hasAnimal) t.push('vegan');
  if (nut.p >= 25 && (nut.p * 4) / Math.max(1, nut.kcal) >= 0.28) t.push('high-protein');
  if (nut.c <= 25 && r.m !== 'snack') t.push('low-carb');
  if ((r.t || 0) <= 20) t.push('schnell');
  if (!hasPricey) t.push('guenstig');
  if (!hasDairy) t.push('laktosefrei');
  if (!hasGluten) t.push('glutenfrei');
  if (r.mp) t.push('mealprep');
  if (!hasFish) t.push('fischfrei');
  if (!hasPork) t.push('schweinefrei');
  if (!hasMushroom) t.push('pilzfrei');
  if (!hasNuts) t.push('nussfrei');
  return t;
}

// ---- Validierung ----
const allMissing = {};
const dupNames = {};
let bad = 0;
for (const r of recipes) {
  if (!r.n || !r.m || !Array.isArray(r.ing) || !Array.isArray(r.s)) { console.error('UNVOLLSTÄNDIG:', r.__file, JSON.stringify(r).slice(0, 80)); bad++; continue; }
  if (!['fruh', 'mittag', 'abend', 'snack'].includes(r.m)) { console.error('MEAL?', r.n, r.m); bad++; }
  const nut = compute(r);
  nut.missing.forEach(k => { allMissing[k] = (allMissing[k] || 0) + 1; });
  dupNames[r.n] = (dupNames[r.n] || 0) + 1;
}
const missKeys = Object.keys(allMissing);
if (missKeys.length) { console.error('FEHLENDE PANTRY-KEYS:', JSON.stringify(allMissing)); }
const dups = Object.entries(dupNames).filter(([, n]) => n > 1);
if (dups.length) console.error('DOPPELTE NAMEN:', dups.map(d => d[0] + ' (' + d[1] + ')').join(' | '));

// Verteilung + Nährwert-Plausibilität
const byMeal = {};
let implausible = 0;
for (const r of recipes) {
  byMeal[r.m] = (byMeal[r.m] || 0) + 1;
  const nut = compute(r);
  const lo = r.m === 'snack' ? 60 : r.m === 'fruh' ? 180 : 250;
  const hi = r.m === 'snack' ? 450 : r.m === 'fruh' ? 700 : 950;
  if (nut.kcal < lo || nut.kcal > hi) { implausible++; if (process.argv.includes('--check')) console.log(`  kcal? ${nut.kcal} [${r.m}] ${r.n}`); }
}
console.log('Verteilung:', JSON.stringify(byMeal));
console.log(`Nährwert-Ausreißer: ${implausible}, fehlerhafte Rezepte: ${bad}, fehlende Keys: ${missKeys.length}, doppelte Namen: ${dups.length}`);

// Stichprobe
if (process.argv.includes('--check')) {
  console.log('\n--- Stichprobe (5) ---');
  for (const r of recipes.slice(0, 5)) {
    const nut = compute(r);
    console.log(`${r.n} [${r.m}] ${nut.kcal} kcal | C${nut.c} P${nut.p} F${nut.f} | ${tagsFor(r, nut).join(',')}`);
  }
  process.exit(missKeys.length || bad ? 1 : 0);
}

// ---- Insert ----
(async () => {
  if (missKeys.length || bad) { console.error('Abbruch: erst Fehler beheben.'); process.exit(1); }
  const mysql = require('mysql2/promise');
  const pool = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER || 'nutridesk',
    password: process.env.DB_PASS, database: process.env.DB_NAME || 'nutridesk',
  });
  await pool.beginTransaction();
  try {
    await pool.execute("DELETE FROM recipe_ingredients WHERE recipe_id IN (SELECT id FROM recipes WHERE source='system')");
    await pool.execute("DELETE FROM recipes WHERE source='system'");
    let n = 0;
    for (const r of recipes) {
      const nut = compute(r);
      const tags = tagsFor(r, nut).join(',');
      const steps = JSON.stringify(r.s);
      const [res] = await pool.execute(
        'INSERT INTO recipes (name, meal, servings, time_min, kcal, carbs, protein, fat, tags, steps, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [r.n.slice(0, 160), r.m, 1, r.t || 0, nut.kcal, nut.c, nut.p, nut.f, tags.slice(0, 255), steps, 'system']);
      const rid = res.insertId;
      if (nut.ings.length) {
        const vals = [];
        const ph = nut.ings.map(ing => {
          vals.push(rid, null, ing.name.slice(0, 160), ing.g, ing.kcal, ing.c, ing.p, ing.f, ing.cat);
          return '(?,?,?,?,?,?,?,?,?)';
        }).join(',');
        await pool.query(
          'INSERT INTO recipe_ingredients (recipe_id, food_id, name, amount_g, kcal, carbs, protein, fat, category) VALUES ' + ph, vals);
      }
      n++;
    }
    await pool.commit();
    console.log(`OK: ${n} Rezepte importiert.`);
  } catch (e) { await pool.rollback(); console.error('ROLLBACK:', e.message); process.exit(1); }
  await pool.end();
})();
