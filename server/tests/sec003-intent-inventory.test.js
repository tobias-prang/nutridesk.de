'use strict';
// SEC-003 Intent-Vollstaendigkeit: jeder von route()/chat erzeugbare Intent hat TTS-Metadaten;
// unbekannte/fehlende Herkunft -> mind. SENSITIVE. node --test tests/sec003-intent-inventory.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { KNOWN_INTENTS, ttsMetaFor } = require('../lib/tts-intents');
const { classifyTtsContent, TTS_POLICY_VERSION } = require('../lib/tts-policy');

test('jeder bekannte Intent hat Metadaten (sources + aktuelle policyVersion)', () => {
  for (const i of KNOWN_INTENTS) {
    const m = ttsMetaFor(i);
    assert.ok(m && Array.isArray(m.sources) && m.sources.length > 0, 'keine sources fuer ' + i);
    assert.strictEqual(m.policyVersion, TTS_POLICY_VERSION, 'policyVersion fuer ' + i);
  }
});
test('unbekannter/fehlender Intent -> Fallback mind. SENSITIVE (nie PUBLIC)', () => {
  for (const i of [undefined, null, '', 'neuer_intent', 'action_done:neu']) {
    const c = classifyTtsContent(ttsMetaFor(i), 'text').classification;
    assert.ok(c === 'SENSITIVE' || c === 'STRICTLY_SENSITIVE', 'Fallback fuer ' + i + ' war ' + c);
  }
});
test('nur die erwarteten Intents ergeben PUBLIC', () => {
  const pub = KNOWN_INTENTS.filter((i) => classifyTtsContent(ttsMetaFor(i), 'x').classification === 'PUBLIC').sort();
  assert.deepStrictEqual(pub, ['cancel', 'confirm', 'food_info', 'greet', 'help', 'smalltalk', 'unknown', 'wiki']);
});
