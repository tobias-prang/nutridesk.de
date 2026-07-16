'use strict';

const HARD = [
  'kacke', 'kacken', 'scheisse', 'scheiss', 'scheisser', 'kotze', 'kotzen', 'exkremente',
  'pisse', 'pissen', 'angepisst', 'sperma', 'wichse', 'wichsen', 'wichser', 'schwanz',
  'penis', 'vagina', 'muschi', 'titten', 'arschloch', 'arsch', 'fotze', 'votze', 'nutte',
  'hure', 'hurensohn', 'hurensöhne', 'schlampe', 'bastard', 'missgeburt', 'ficken', 'fick', 'ficker',
  'gefickt', 'analverkehr', 'kotgeschmack',
  'shit', 'crap', 'piss', 'cum', 'cock', 'pussy', 'bitch', 'whore', 'slut', 'asshole',
  'fuck', 'fucking', 'fucker', 'motherfucker', 'bollocks', 'wanker', 'cunt',
];

const SLUR = [
  'neger', 'nigger', 'nigga', 'kanake', 'kanacke', 'judensau', 'untermensch',
  'schwuchtel', 'spast', 'spasti', 'mongo', 'behindi', 'kruppel', 'krueppel',
  'faggot', 'retard', 'tranny', 'chink',
];

const SOFT = [
  'idiot', 'trottel', 'depp', 'vollidiot', 'dummkopf', 'blodmann', 'bloedmann',
  'penner', 'assi', 'spinner', 'volltrottel', 'hohlkopf', 'bescheuert', 'behindert',
  'moron', 'stupid', 'dumbass',
];

const EXACT_ONLY = new Set([
  'arsch', 'mongo', 'spast', 'spasti', 'neger', 'nigga', 'hure', 'fick', 'cum', 'crap',
  'shit', 'piss', 'cock', 'fuck', 'slut', 'cunt', 'depp', 'assi', 'kotze', 'chink',
  'pussy', 'bitch', 'whore', 'moron', 'penis', 'vagina', 'sperma', 'nutte',
  'schwanz', 'bastard', 'muschi', 'faggot', 'titten', 'transe', 'retard',
]);

const ALLOW = new Set([
  'barsch', 'barsche', 'marsch', 'marschieren', 'mongolei', 'mongolisch', 'mongolische',
  'mongolisches', 'mongolischer', 'mongole', 'mongolen', 'spastisch', 'spastik',
  'analyse', 'analysieren', 'analytik', 'assiette', 'assistent', 'assistenz',
  'dickmilch', 'dickungsmittel', 'blase', 'blasen', 'scheissegal', 'penne', 'pennette',
  'shiitake', 'cocktail', 'cocktails', 'spermidin', 'huhn', 'huehner',
  'weniger', 'niger', 'nigeria', 'nigerianer', 'nigerianisch', 'spinnerei', 'spinnereien',
  'deep', 'fagot', 'fagots', 'pissenlit', 'pissenlits', 'morron', 'morrones', 'monggo',
  'muschio', 'pissaladiere', 'schinken', 'jerk',
]);

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i' };

function fold(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[0134578@$!]/g, (c) => LEET[c] || c)
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const squeeze = (w) => w.replace(/(.)\1+/g, '$1');

function buildIndex() {
  const exact = new Map();
  const part = new Map();
  const add = (list, level) => {
    for (const w of list) {
      const f = fold(w);
      if (!f) continue;
      exact.set(squeeze(f), level);
      if (f.length >= 5 && !EXACT_ONLY.has(w)) part.set(f, level);
    }
  };
  add(SOFT, 'soft');
  add(HARD, 'hard');
  add(SLUR, 'slur');
  return { exact, part };
}

const INDEX = buildIndex();
const RANK = { none: 0, soft: 1, hard: 2, slur: 3 };

function scanWord(raw) {
  if (ALLOW.has(raw)) return null;
  const direct = INDEX.exact.get(squeeze(raw));
  if (direct) return direct;
  for (const [bad, level] of INDEX.part) {
    if (raw.length > bad.length && raw.includes(bad)) return level;
  }
  return null;
}

function scan(text) {
  const hits = [];
  const seen = new Set();
  for (const raw of fold(text).split(' ')) {
    if (!raw || seen.has(raw)) continue;
    const level = scanWord(raw);
    if (level) { seen.add(raw); hits.push({ word: raw, level }); }
  }
  const worst = hits.reduce((a, h) => (RANK[h.level] > RANK[a] ? h.level : a), 'none');
  return { hits, worst, clean: !hits.length };
}

function mask(text) {
  return String(text || '').replace(/[\p{L}\p{N}@$!*]+/gu, (tok) => {
    const core = tok.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
    if (!core) return tok;
    const level = scanWord(fold(core));
    if (level !== 'hard' && level !== 'slur') return tok;
    return tok.replace(core, core[0] + '*'.repeat(Math.max(1, core.length - 1)));
  });
}

module.exports = { scan, mask, fold };
