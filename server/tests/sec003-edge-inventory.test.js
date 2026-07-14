'use strict';
// SEC-003 Edge-Runtime-Inventar + Cache-Header + Provider-Allowlist (Code-Inventar).
// node --test tests/sec003-edge-inventory.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bot = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

test('keine aktive Edge-TTS-Nutzung im Bot (edge-tts/TTS_BIN/execFile/EdgeTtsProvider)', () => {
  for (const token of ['edge-tts', 'EDGE_TTS_BIN', 'TTS_BIN', 'execFile', 'EdgeTtsProvider']) {
    assert.ok(bot.indexOf(token) === -1, 'noch vorhanden in bot.js: ' + token);
  }
});
test('/bot/tts: keine oeffentlichen Cache-Header; private/no-store + nosniff + Vary Authorization', () => {
  assert.ok(!/Cache-Control['"]\s*,\s*['"]public/.test(bot), 'oeffentlicher Cache-Control gefunden');
  assert.ok(bot.indexOf("'private, no-store'") !== -1);
  assert.ok(bot.indexOf('X-Content-Type-Options') !== -1 && bot.indexOf('nosniff') !== -1);
  assert.ok(bot.indexOf("'Vary'") !== -1 && bot.indexOf('Authorization') !== -1);
});
test('Provider-Allowlist ist genau [elevenlabs]', () => {
  const { CLOUD_TTS_PROVIDERS } = require('../lib/tts-policy');
  assert.deepStrictEqual(CLOUD_TTS_PROVIDERS, ['elevenlabs']);
});
