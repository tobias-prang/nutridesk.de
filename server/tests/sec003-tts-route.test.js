'use strict';
// SEC-003 Route-/Haertungstests (Entscheidungslogik decideTts, gemockter Provider-Spy).
// node --test tests/sec003-tts-route.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { decideTts, redactTtsContent, TTS_POLICY_VERSION, TTS_PRIVACY_NOTICE_VERSION } = require('../lib/tts-policy');

function simulateRoute(o, providerSpy) {
  const cloudAvailable = o.cloudAvailable !== undefined ? o.cloudAvailable : true;
  const privacy = o.privacyNoticeVersion !== undefined ? o.privacyNoticeVersion : TTS_PRIVACY_NOTICE_VERSION;
  if (!o.msg || o.msg.role !== 'bot') return { status: 404, providerCalled: false };
  let meta = {}; try { meta = o.msg.tts_meta ? JSON.parse(o.msg.tts_meta) : {}; } catch (e) { meta = {}; }
  const d = decideTts({ meta, text: o.msg.text, settings: o.settings, explicit: o.explicit, cloudAvailable, currentPrivacyNoticeVersion: privacy });
  if (d.action !== 'cloud') return { status: 200, mode: 'blocked', localEligible: !!d.localEligible, classification: d.classification, reason: d.reason, providerCalled: false };
  let out = o.msg.text; if (d.redact) out = redactTtsContent(out).text;
  providerSpy(out);
  return { status: 200, mode: 'cloud', classification: d.classification, providerCalled: true, out };
}
const spy = () => { const f = (t) => { f.calls.push(t); }; f.calls = []; return f; };
const msg = (text, ttsMeta) => ({ id: 1, user_id: 7, role: 'bot', text, tts_meta: ttsMeta });
const J = (o) => JSON.stringify(o);
const PUB = J({ sources: ['static'], policyVersion: TTS_POLICY_VERSION });
const BAL = J({ sources: ['user_data'], containsUserText: true, policyVersion: TTS_POLICY_VERSION });
const ACT = J({ sources: ['user_action'], containsUserText: true, containsPrivateFreeText: true, policyVersion: TTS_POLICY_VERSION });
const OPT_IN = { cloud_tts_enabled: 1, cloud_tts_privacy_version: TTS_PRIVACY_NOTICE_VERSION };
const noProvider = (r, p) => { assert.strictEqual(r.providerCalled, false); assert.strictEqual(p.calls.length, 0); assert.strictEqual(r.mode, 'blocked'); };

test('Opt-out: PUBLIC ohne Opt-in -> blocked, kein Provider', () => { const p = spy(); noProvider(simulateRoute({ msg: msg('Hallo', PUB), settings: { cloud_tts_enabled: 0 }, explicit: true }, p), p); });
test('PUBLIC Opt-in ohne Klick -> blocked, kein Provider', () => { const p = spy(); noProvider(simulateRoute({ msg: msg('Hallo', PUB), settings: OPT_IN, explicit: false }, p), p); });
test('PUBLIC Opt-in + Klick + global an -> Provider', () => { const p = spy(); const r = simulateRoute({ msg: msg('Hallo', PUB), settings: OPT_IN, explicit: true, cloudAvailable: true }, p); assert.strictEqual(r.providerCalled, true); });

test('GLOBALE SPERRE aus: PUBLIC + Opt-in + Klick -> blocked, localEligible true, kein Provider', () => { const p = spy(); const r = simulateRoute({ msg: msg('Hallo', PUB), settings: OPT_IN, explicit: true, cloudAvailable: false }, p); assert.strictEqual(r.reason, 'cloud_globally_disabled'); assert.strictEqual(r.localEligible, true); noProvider(r, p); });

test('PRIVACY-NOTICE-VERSION alt -> blocked, kein Provider', () => { const p = spy(); const r = simulateRoute({ msg: msg('Hallo', PUB), settings: { cloud_tts_enabled: 1, cloud_tts_privacy_version: 'alt' }, explicit: true }, p); assert.strictEqual(r.reason, 'privacy_notice_version_mismatch'); noProvider(r, p); });
test('PRIVACY-NOTICE-VERSION NULL -> blocked, kein Provider', () => { const p = spy(); noProvider(simulateRoute({ msg: msg('Hallo', PUB), settings: { cloud_tts_enabled: 1, cloud_tts_privacy_version: null }, explicit: true }, p), p); });

test('Kontostand -> blocked, localEligible true, nie Provider', () => { const p = spy(); const r = simulateRoute({ msg: msg('Saldo 1000 EUR', BAL), settings: OPT_IN, explicit: true }, p); assert.strictEqual(r.localEligible, true); noProvider(r, p); });
test('Gewicht -> blocked, nie Provider', () => { const p = spy(); noProvider(simulateRoute({ msg: msg('82 kg', J({ sources: ['weight'], policyVersion: TTS_POLICY_VERSION })), settings: OPT_IN, explicit: true }, p), p); });
test('Termin/Todo (user_action) -> blocked, nie Provider', () => { const p = spy(); noProvider(simulateRoute({ msg: msg('Arzt 24.12.', ACT), settings: OPT_IN, explicit: true }, p), p); });

test('defekte Metadaten (ungueltiges JSON) -> SENSITIVE, blocked, kein Provider', () => { const p = spy(); const r = simulateRoute({ msg: msg('Saldo', 'kein json'), settings: OPT_IN, explicit: true }, p); assert.strictEqual(r.classification, 'SENSITIVE'); noProvider(r, p); });
test('tts_meta NULL -> SENSITIVE, blocked, kein Provider', () => { const p = spy(); const r = simulateRoute({ msg: msg('Saldo', null), settings: OPT_IN, explicit: true }, p); assert.strictEqual(r.classification, 'SENSITIVE'); noProvider(r, p); });
test('PUBLIC-Herkunft ohne policyVersion -> SENSITIVE, blocked, kein Provider', () => { const p = spy(); const r = simulateRoute({ msg: msg('Hallo', J({ sources: ['static'] })), settings: OPT_IN, explicit: true }, p); assert.strictEqual(r.classification, 'SENSITIVE'); noProvider(r, p); });

test('harte Sperre: PUBLIC-Metadaten + PIN -> STRICTLY, localEligible false, kein Provider', () => { const p = spy(); const r = simulateRoute({ msg: msg('Deine PIN ist 1234', PUB), settings: OPT_IN, explicit: true }, p); assert.strictEqual(r.classification, 'STRICTLY_SENSITIVE'); assert.strictEqual(r.localEligible, false); noProvider(r, p); });
test('harte Sperre: PUBLIC + TAN -> kein Provider', () => { const p = spy(); noProvider(simulateRoute({ msg: msg('TAN 483920', PUB), settings: OPT_IN, explicit: true }, p), p); });
test('harte Sperre: PUBLIC + volle IBAN -> kein Provider', () => { const p = spy(); noProvider(simulateRoute({ msg: msg('DE44 5001 0517 5407 3249 31', PUB), settings: OPT_IN, explicit: true }, p), p); });
test('harte Sperre: PUBLIC + API-Key -> kein Provider', () => { const p = spy(); noProvider(simulateRoute({ msg: msg('key sk_live_abcdefghijklmnop', PUB), settings: OPT_IN, explicit: true }, p), p); });

test('manipulierte Client-Klasse in meta ignoriert (SENSITIVE)', () => { const p = spy(); const r = simulateRoute({ msg: msg('Saldo 1000 EUR', J({ sources: ['user_data'], classification: 'PUBLIC', cloudEligible: true, policyVersion: TTS_POLICY_VERSION })), settings: OPT_IN, explicit: true }, p); assert.strictEqual(r.classification, 'SENSITIVE'); noProvider(r, p); });
test('fremde/geloeschte message_id -> 404, kein Provider', () => { const p = spy(); const r = simulateRoute({ msg: null, settings: OPT_IN, explicit: true }, p); assert.strictEqual(r.status, 404); assert.strictEqual(p.calls.length, 0); });
test('widerrufenes Opt-in -> blocked, kein Provider', () => { const p = spy(); noProvider(simulateRoute({ msg: msg('Hallo', PUB), settings: { cloud_tts_enabled: 0 }, explicit: true }, p), p); });
