'use strict';
// SEC-001 echter Express-Routentest (node:test): startet eine reale Express-App, sendet per HTTP
// POST /bank/connect mit einem url-Feld im Body und prueft, dass dieses IGNORIERT wird und der
// PinTanClient nur die DB-URL bekommt. Kein echter PinTanClient/DB, keine PIN/Bankdaten.
// node --test tests/sec001-express-route.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const { buildConnectClient } = require('../lib/bank-connect');

function spyClient() {
  const calls = [];
  const make = (o) => { calls.push(o); return { accounts: async () => [{ iban: 'DE00' }] }; };
  make.calls = calls;
  return make;
}
// dbUrl = was die banks-Tabelle liefert (null = kein Eintrag). Route liest NUR blz/login/pin aus dem Body.
function buildApp(dbUrl, make) {
  const app = express();
  app.use(express.json());
  const pool = { execute: async () => [[...(dbUrl ? [{ fints_url: dbUrl }] : [])]] };
  app.post('/bank/connect', async (req, res) => {
    const { blz, login, pin } = req.body; // req.body.url wird bewusst NICHT gelesen
    try {
      const { url, client } = await buildConnectClient({ pool, makeClient: make, blz, login, pin });
      await client.accounts();
      res.json({ ok: true, urlUsed: url });
    } catch (e) { res.status(400).json({ ok: false, code: e.code || 'error' }); }
  });
  return app;
}
function post(app, body) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      const data = JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/bank/connect',
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => { srv.close(); resolve({ status: resp.statusCode, body: JSON.parse(b || '{}') }); }); });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.write(data); req.end();
    });
  });
}

test('POST /bank/connect: req.body.url wird ignoriert, nur DB-URL genutzt', async () => {
  const make = spyClient();
  const app = buildApp('https://8.8.8.8/fints', make);
  const r = await post(app, { blz: '10010010', login: 'u', pin: 'geheim', url: 'https://127.0.0.1/' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.urlUsed, 'https://8.8.8.8/fints');
  assert.strictEqual(make.calls.length, 1);
  assert.strictEqual(make.calls[0].url, 'https://8.8.8.8/fints'); // NICHT 127.0.0.1
});

test('POST /bank/connect: Banktabelle mit interner URL -> Client nicht erstellt, 400', async () => {
  const make = spyClient();
  const app = buildApp('https://127.0.0.1/fints', make);
  const r = await post(app, { blz: '1', login: 'u', pin: 'p', url: 'https://evil.example/' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'blocked_host');
  assert.strictEqual(make.calls.length, 0);
});

test('POST /bank/connect: keine DB-URL -> geschlossener Fehlschlag, Client nicht erstellt', async () => {
  const make = spyClient();
  const app = buildApp(null, make);
  const r = await post(app, { blz: '99999999', login: 'u', pin: 'p', url: 'https://8.8.8.8/' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'no_bank_url');
  assert.strictEqual(make.calls.length, 0);
});
