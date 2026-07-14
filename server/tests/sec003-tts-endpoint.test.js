'use strict';
// SEC-003 ECHTE Express-Routentests fuer /bot/tts (registerBot mit Mock-Deps, gemocktem pool,
// abgefangenem ElevenLabs-Call). node --test tests/sec003-tts-endpoint.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { TTS_POLICY_VERSION, TTS_PRIVACY_NOTICE_VERSION } = require('../lib/tts-policy');

// Dummy-ElevenLabs-Config, damit elevenCfg() einen Key liefert (echter Netz-Call wird abgefangen).
const elFile = path.join(os.tmpdir(), 'sec003-el-' + process.pid + '.json');
fs.writeFileSync(elFile, JSON.stringify({ key: 'test', woman: 'v', man: 'v', model: 'm' }));
process.env.ELEVENLABS_FILE = elFile;

// https.request abfangen: keine echten ElevenLabs-Aufrufe, aber zaehlen.
const https = require('https');
const realRequest = https.request;
let elCalls = 0;
https.request = function (opts, cb) {
  const host = (opts && (opts.hostname || opts.host)) || '';
  if (String(host).indexOf('elevenlabs') !== -1) {
    elCalls++;
    const { Readable } = require('stream');
    const res = new Readable({ read() {} }); res.statusCode = 200;
    process.nextTick(() => { if (cb) cb(res); res.push(Buffer.alloc(500, 1)); res.push(null); });
    return { on() { return this; }, write() {}, end() {}, destroy() {}, setTimeout() {} };
  }
  return realRequest.apply(this, arguments);
};
process.on('exit', () => { https.request = realRequest; try { fs.unlinkSync(elFile); } catch (e) {} });

const registerBot = require('../bot');

function makeDeps(state) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const vInt = (v, name, min, max, opts) => { if (v === undefined || v === null || v === '') { if (opts && opts.optional) return undefined; throw bad(name + ' fehlt'); } const n = parseInt(v, 10); if (isNaN(n)) throw bad(name + ' ungueltig'); return n; };
  const vStr = (v, name, max, opts) => { if (v === undefined || v === null || v === '') { if (opts && opts.optional) return undefined; throw bad(name + ' fehlt'); } return String(v).slice(0, max || 1000); };
  const vEnum = (v, name, arr, opts) => { if (v === undefined || v === null || v === '') { if (opts && opts.optional) return undefined; throw bad(name + ' fehlt'); } if (!arr.includes(v)) throw bad(name + ' ungueltig'); return v; };
  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => { res.status(e.status || 500).json({ error: e.message || 'Fehler' }); });
  const pool = { execute: async (sql) => {
    if (/FROM bot_chat/.test(sql)) return [state.msg ? [state.msg] : []];
    if (/FROM user_settings/.test(sql)) return [[state.settings || {}]];
    return [[]];
  } };
  return {
    pool, auth: (req, res, next) => { req.uid = 7; next(); }, requireAdmin: (req, res, next) => next(),
    asyncRoute, bad, HttpError: class extends Error {},
    vStr, vInt, vNum: (v) => Number(v), vDate: (v) => v, vEnum, vBool: (v) => !!v,
    rateLimitUser: () => (req, res, next) => next(), reqIp: () => 'test', logEvent: () => {}, botPost: async () => {},
  };
}
function buildApp(cloudAvailable, state) {
  process.env.CLOUD_TTS_AVAILABLE = cloudAvailable ? '1' : '0';
  const app = express(); app.use(express.json());
  registerBot(app, makeDeps(state));
  return app;
}
function post(app, body) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      const data = JSON.stringify(body);
      const r = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/bot/tts', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer x' } },
        (resp) => { let b = ''; resp.on('data', (c) => (b += c)); resp.on('end', () => { srv.close(); let j = null; try { j = JSON.parse(b); } catch (e) { j = { _bytes: b.length }; } resolve({ status: resp.statusCode, ct: resp.headers['content-type'] || '', body: j }); }); });
      r.on('error', (e) => { srv.close(); reject(e); }); r.write(data); r.end();
    });
  });
}
const J = (o) => JSON.stringify(o);
const botMsg = (text, meta) => ({ id: 5, user_id: 7, role: 'bot', text, tts_meta: meta });
const OPT_IN = { cloud_tts_enabled: 1, cloud_tts_privacy_version: TTS_PRIVACY_NOTICE_VERSION };

test('ENDPOINT tts_meta NULL -> kein Provider, kein 500, blocked, >=SENSITIVE', async () => {
  elCalls = 0;
  const r = await post(buildApp(true, { msg: botMsg('Dein Saldo 1000 EUR', null), settings: OPT_IN }), { message_id: 5, explicit: true });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.mode, 'blocked');
  assert.ok(['SENSITIVE', 'STRICTLY_SENSITIVE'].includes(r.body.classification)); assert.strictEqual(elCalls, 0);
});
test('ENDPOINT tts_meta ungueltiges JSON -> kein Provider, kein 500, blocked, >=SENSITIVE', async () => {
  elCalls = 0;
  const r = await post(buildApp(true, { msg: botMsg('Dein Saldo 1000 EUR', 'kaputt{'), settings: OPT_IN }), { message_id: 5, explicit: true });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.mode, 'blocked');
  assert.ok(['SENSITIVE', 'STRICTLY_SENSITIVE'].includes(r.body.classification)); assert.strictEqual(elCalls, 0);
});
test('ENDPOINT unbekannte TTS_POLICY_VERSION -> kein Provider, blocked', async () => {
  elCalls = 0;
  const r = await post(buildApp(true, { msg: botMsg('Hallo', J({ sources: ['static'], policyVersion: '999' })), settings: OPT_IN }), { message_id: 5, explicit: true });
  assert.strictEqual(r.body.mode, 'blocked'); assert.strictEqual(elCalls, 0);
});
test('ENDPOINT PUBLIC + globale Freigabe AUS -> blocked, localEligible true, kein Provider', async () => {
  elCalls = 0;
  const r = await post(buildApp(false, { msg: botMsg('Hallo', J({ sources: ['static'], policyVersion: TTS_POLICY_VERSION })), settings: OPT_IN }), { message_id: 5, explicit: true });
  assert.strictEqual(r.body.mode, 'blocked'); assert.strictEqual(r.body.localEligible, true); assert.strictEqual(elCalls, 0);
});
test('ENDPOINT PUBLIC + Freigabe AN + gueltiges Opt-in + Klick -> Provider aufgerufen (Audio)', async () => {
  elCalls = 0;
  const r = await post(buildApp(true, { msg: botMsg('Hallo, wie kann ich helfen?', J({ sources: ['static'], policyVersion: TTS_POLICY_VERSION })), settings: OPT_IN }), { message_id: 5, explicit: true });
  assert.strictEqual(r.status, 200); assert.ok(r.ct.indexOf('audio') !== -1, 'audio erwartet, ct=' + r.ct); assert.strictEqual(elCalls, 1);
});
