'use strict';
// SEC-003 Policy-Unit-Tests. node --test tests/sec003-tts-policy.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  TTS_POLICY_VERSION, classifyTtsContent, scanForbiddenTtsContent, redactTtsContent,
  isCloudTtsAllowed, isLocalTtsAllowed,
} = require('../lib/tts-policy');

const PV = TTS_POLICY_VERSION;
const cls = (meta, text) => classifyTtsContent(meta, text).classification;
const optIn = { cloud_tts_enabled: 1 };
const optOut = { cloud_tts_enabled: 0 };

test('Klassifizierung nach Datenherkunft (mit aktueller policyVersion)', () => {
  assert.strictEqual(cls({ sources: ['static'], policyVersion: PV }, 'Hallo!'), 'PUBLIC');
  assert.strictEqual(cls({ sources: ['food_db'], policyVersion: PV }, 'Nutella'), 'PUBLIC');
  assert.strictEqual(cls({ sources: ['weather', 'location'], policyVersion: PV }, '12 Grad'), 'PRIVATE');
  assert.strictEqual(cls({ sources: ['bank_balance'], policyVersion: PV }, 'Saldo'), 'SENSITIVE');
  assert.strictEqual(cls({ sources: ['weight'], policyVersion: PV }, '82 kg'), 'SENSITIVE');
  assert.strictEqual(cls({ sources: ['private_note'], policyVersion: PV }, 'x'), 'STRICTLY_SENSITIVE');
});
test('fehlende/veraltete/unbekannte Metadaten-Policyversion -> mind. SENSITIVE', () => {
  assert.strictEqual(cls({ sources: ['static'] }, 'Hallo!'), 'SENSITIVE');            // fehlt
  assert.strictEqual(cls({ sources: ['static'], policyVersion: 'alt' }, 'Hallo!'), 'SENSITIVE'); // veraltet
  assert.strictEqual(cls({ sources: ['static'], policyVersion: PV }, 'Hallo!'), 'PUBLIC');       // aktuell
});
test('unbekannte Herkunft / freier Nutzertext -> mind. SENSITIVE', () => {
  assert.strictEqual(cls({ sources: [], policyVersion: PV }, 'x'), 'SENSITIVE');
  assert.strictEqual(cls({ sources: ['weird'], policyVersion: PV }, 'x'), 'SENSITIVE');
  assert.strictEqual(cls({ sources: ['static'], policyVersion: PV, containsUserText: true }, 'x'), 'SENSITIVE');
});
test('harte Sperre erzwingt STRICTLY, auch bei PUBLIC-Herkunft', () => {
  assert.strictEqual(cls({ sources: ['static'], policyVersion: PV }, 'PIN 1234'), 'STRICTLY_SENSITIVE');
  assert.strictEqual(cls({ sources: ['static'], policyVersion: PV }, 'TAN 483920'), 'STRICTLY_SENSITIVE');
  assert.strictEqual(cls({ sources: ['static'], policyVersion: PV }, 'DE44 5001 0517 5407 3249 31'), 'STRICTLY_SENSITIVE');
  assert.strictEqual(cls({ sources: ['static'], policyVersion: PV }, 'token sk_live_abcdefghijklmnop'), 'STRICTLY_SENSITIVE');
});
test('scanForbiddenTtsContent', () => {
  for (const t of ['PIN 1234', 'deine TAN 483920', 'DE44 5001 0517 5407 3249 31', '4111 1111 1111 1111'])
    assert.ok(scanForbiddenTtsContent(t).blocked, t);
  assert.ok(!scanForbiddenTtsContent('Saldo 1.842,22 EUR, 12 Grad').blocked);
});
test('redactTtsContent maskiert IBAN + E-Mail', () => {
  const r = redactTtsContent('DE44 5001 0517 5407 3249 31 mail a@b.de', 'PRIVATE');
  assert.ok(/eine IBAN/.test(r.text) && /eine E-Mail-Adresse/.test(r.text) && r.redactionApplied);
});
test('isCloudTtsAllowed (Nutzer-Ebene)', () => {
  assert.strictEqual(isCloudTtsAllowed(optIn, 'PUBLIC', true).allowed, true);
  assert.strictEqual(isCloudTtsAllowed(optIn, 'PUBLIC', false).allowed, false);
  assert.strictEqual(isCloudTtsAllowed(optOut, 'PUBLIC', true).allowed, false);
  assert.strictEqual(isCloudTtsAllowed(optIn, 'PRIVATE', true).redact, true);
  assert.strictEqual(isCloudTtsAllowed(optIn, 'SENSITIVE', true).allowed, false);
  assert.strictEqual(isCloudTtsAllowed(optIn, 'STRICTLY_SENSITIVE', true).allowed, false);
});
test('isLocalTtsAllowed', () => {
  assert.strictEqual(isLocalTtsAllowed('SENSITIVE', false), true);
  assert.strictEqual(isLocalTtsAllowed('STRICTLY_SENSITIVE', false), false);
  assert.strictEqual(isLocalTtsAllowed('SENSITIVE', true), false);
});
