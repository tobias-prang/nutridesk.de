'use strict';
// SEC-001 Route-Logik-Tests (node:test): buildConnectClient/buildSyncClient mit gemocktem PinTanClient.
// node --test tests/sec001-bank-routes.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildConnectClient, buildSyncClient } = require('../lib/bank-connect');

function spyClient() {
  const calls = [];
  const make = (opts) => { calls.push(opts); return { accounts: async () => [{ iban: 'DE00', bankName: 'Testbank' }] }; };
  make.calls = calls;
  return make;
}
const OK = 'https://8.8.8.8/fints';
const poolWith = (url) => ({ execute: async () => [[{ fints_url: url }]] });
const poolEmpty = { execute: async () => [[]] };
const hasCode = (code) => (e) => e.code === code;

test('connect: PinTanClient erhaelt AUSSCHLIESSLICH die banks-URL', async () => {
  const make = spyClient();
  const { url } = await buildConnectClient({ pool: poolWith(OK), makeClient: make, blz: '10010010', login: 'u', pin: 'geheim' });
  assert.strictEqual(make.calls.length, 1);
  assert.strictEqual(make.calls[0].url, OK);
  assert.strictEqual(url, OK);
});
test('connect: client-artiges Extra-Feld hat keinen Einfluss', async () => {
  const make = spyClient();
  await buildConnectClient({ pool: poolWith(OK), makeClient: make, blz: '1', login: 'u', pin: 'p', url: 'http://127.0.0.1' });
  assert.strictEqual(make.calls[0].url, OK);
});
test('connect: banks-URL intern (127.0.0.1) -> Client NICHT gebaut', async () => {
  const make = spyClient();
  await assert.rejects(buildConnectClient({ pool: poolWith('https://127.0.0.1/fints'), makeClient: make, blz: '1', login: 'u', pin: 'p' }), hasCode('blocked_host'));
  assert.strictEqual(make.calls.length, 0);
});
test('connect: keine Bank-URL -> Client NICHT gebaut', async () => {
  const make = spyClient();
  await assert.rejects(buildConnectClient({ pool: poolEmpty, makeClient: make, blz: '99999999', login: 'u', pin: 'p' }), hasCode('no_bank_url'));
  assert.strictEqual(make.calls.length, 0);
});
test('sync: gueltige gespeicherte URL -> Client gebaut', async () => {
  const make = spyClient();
  const { url } = await buildSyncClient({ makeClient: make, storedUrl: OK, blz: '1', login: 'u', pin: 'p' });
  assert.strictEqual(make.calls.length, 1);
  assert.strictEqual(url, OK);
});
test('sync: Host loest jetzt privat auf -> Client NICHT gebaut', async () => {
  const make = spyClient();
  await assert.rejects(buildSyncClient({ makeClient: make, storedUrl: 'https://127.0.0.1/', blz: '1', login: 'u', pin: 'p' }), hasCode('blocked_host'));
  assert.strictEqual(make.calls.length, 0);
});
test('sync: IPv4-Mapped-IPv6-Loopback -> Client NICHT gebaut', async () => {
  const make = spyClient();
  await assert.rejects(buildSyncClient({ makeClient: make, storedUrl: 'https://[::ffff:7f00:1]/', blz: '1', login: 'u', pin: 'p' }), hasCode('blocked_host'));
  assert.strictEqual(make.calls.length, 0);
});
