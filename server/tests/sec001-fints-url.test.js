'use strict';
// SEC-001 Unit-Tests (node:test). Deterministisch (nur IP-Literale, keine PIN/Bankdaten).
// Ausfuehren: node --test tests/sec001-fints-url.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { validateFintsUrl, resolveFintsUrl, isBlockedIp } = require('../lib/fints-url');

const OKURL = 'https://8.8.8.8/fints'; // global routbares Unicast-Literal (DNS offline deterministisch)
const poolWith = (url) => ({ execute: async () => [[{ fints_url: url }]] });
const poolEmpty = { execute: async () => [[]] };
const poolNull = { execute: async () => [[{ fints_url: null }]] };
const hasCode = (code) => (e) => e.code === code;

test('vertrauenswuerdige global-unicast URL -> ok', async () => {
  assert.strictEqual(await validateFintsUrl(OKURL), OKURL);
});
test('resolveFintsUrl liefert banks-URL, ignoriert Zusatzargumente', async () => {
  assert.strictEqual(await resolveFintsUrl(poolWith(OKURL), '12345678', 'https://attacker.example'), OKURL);
});
test('server.js enthaelt keinen req.body.url-Zugriff', () => {
  assert.ok(!/req\.body\.url/.test(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')));
});

const BLOCKED = [
  'https://127.0.0.1/fints', 'https://localhost/fints', 'https://169.254.169.254/',
  'https://10.0.0.5/', 'https://192.168.1.1/', 'https://172.16.0.1/', 'https://100.64.0.1/',
  'https://198.18.0.1/', 'https://203.0.113.20/',
  'https://[::1]/', 'https://[fd00::1]/', 'https://[fe80::1]/',
  'https://[::ffff:7f00:1]/', 'https://[::7f00:1]/', 'https://[fec0::1]/', 'https://[ff02::1]/',
];
for (const u of BLOCKED) {
  test('lehnt gesperrtes Ziel ab: ' + u, () => assert.rejects(validateFintsUrl(u), hasCode('blocked_host')));
}

test('lehnt http ab', () => assert.rejects(validateFintsUrl('http://fints.example.de/'), hasCode('not_https')));
test('lehnt User/Passwort ab', () => assert.rejects(validateFintsUrl('https://user:password@example.com/'), hasCode('userinfo_not_allowed')));
test('lehnt nicht-erlaubten Port ab', () => assert.rejects(validateFintsUrl('https://8.8.8.8:8443/'), hasCode('port_not_allowed')));
test('lehnt ungueltige URL ab', () => assert.rejects(validateFintsUrl('nonsense'), hasCode('invalid_url')));
test('Bank ohne URL -> fail closed', () => assert.rejects(resolveFintsUrl(poolEmpty, '99999999'), hasCode('no_bank_url')));
test('Bank mit NULL-URL -> fail closed', () => assert.rejects(resolveFintsUrl(poolNull, '99999999'), hasCode('no_bank_url')));

test('isBlockedIp: gesperrte Bereiche', () => {
  for (const b of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1', '169.254.169.254', '100.64.0.1',
    '198.18.0.1', '203.0.113.20', '::1', 'fd00::1', 'fe80::1', 'fec0::1', '::7f00:1', '::ffff:127.0.0.1',
    'ff02::1', '::']) assert.ok(isBlockedIp(b), 'sollte gesperrt sein: ' + b);
});
test('isBlockedIp: global routbare erlaubt', () => {
  for (const g of ['8.8.8.8', '1.1.1.1', '84.247.187.234', '2606:4700:4700::1111']) assert.ok(!isBlockedIp(g), 'sollte erlaubt sein: ' + g);
});
