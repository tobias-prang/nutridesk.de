'use strict';
// SEC-004A FD-Lebenszyklus: open/close pro fd instrumentiert (kein HTTP-Server -> sauberer Exit).
// node --test tests/sec004a-fd-lifecycle.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable, Readable } = require('stream');
const { serveCloudFile } = require('../lib/cloud-download');

const dir = path.join(os.tmpdir(), 'sec004a-fd-' + process.pid);
fs.mkdirSync(dir, { recursive: true });
const small = path.join(dir, 'small'); fs.writeFileSync(small, 'hello');
const big = path.join(dir, 'big'); fs.writeFileSync(big, Buffer.alloc(4 * 1024 * 1024, 7));
const link = path.join(dir, 'link'); try { fs.symlinkSync('/etc/hostname', link); } catch (e) {}
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

const realOpen = fs.openSync, realCloseSync = fs.closeSync, realClose = fs.close;
let opened = [], closed = [];
fs.openSync = function (...a) { const fd = realOpen.apply(fs, a); opened.push(fd); return fd; };
fs.closeSync = function (fd) { closed.push(fd); return realCloseSync.call(fs, fd); };
fs.close = function (fd, cb) { closed.push(fd); return realClose.call(fs, fd, cb || (() => {})); };
process.on('exit', () => { fs.openSync = realOpen; fs.closeSync = realCloseSync; fs.close = realClose; });
const reset = () => { opened = []; closed = []; };
const closesOf = (fd) => closed.filter((x) => x === fd).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (em, ev) => new Promise((r) => em.once(ev, r));

function mockRes() {
  const r = new Writable({ write(c, e, cb) { setImmediate(cb); } }); // langsam genug fuer mehrere Chunks
  r.headers = {}; r.headersSent = false; r.statusCalls = 0; r.destroyCalls = 0;
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.getHeader = (k) => r.headers[k.toLowerCase()];
  r.vary = (f) => { const c = r.getHeader('vary'); r.setHeader('Vary', c ? c + ', ' + f : f); };
  r.status = () => { r.statusCalls++; return r; };
  r.json = () => r;
  const od = r.destroy.bind(r); r.destroy = () => { r.destroyCalls++; return od(); };
  return r;
}

test('normaler vollstaendiger Download -> genau ein FD, genau einmal geschlossen', async () => {
  reset(); const res = mockRes();
  serveCloudFile(res, { diskPath: small, name: 'x', dbSize: 5 });
  await once(res, 'finish'); await sleep(40);
  assert.strictEqual(opened.length, 1); assert.strictEqual(closesOf(opened[0]), 1);
});

test('Fehler vor Streambeginn (Groessen-Mismatch) -> FD geschlossen, 404', () => {
  reset(); const res = mockRes();
  serveCloudFile(res, { diskPath: small, name: 'x', dbSize: 99999 }); // synchroner Guard
  assert.strictEqual(res.statusCalls, 1); assert.strictEqual(opened.length, 1); assert.strictEqual(closesOf(opened[0]), 1);
});

test('Symlink -> openSync schlaegt fehl, kein FD geoeffnet, 404', () => {
  reset(); const res = mockRes();
  serveCloudFile(res, { diskPath: link, name: 'x', dbSize: null });
  assert.strictEqual(res.statusCalls, 1); assert.strictEqual(opened.length, 0);
});

test('Client-Abbruch -> Stream zerstoert, FD genau einmal geschlossen', async () => {
  reset(); const res = mockRes();
  serveCloudFile(res, { diskPath: big, name: 'x', dbSize: 4 * 1024 * 1024 });
  res.emit('close'); // simulierter Verbindungsabbruch -> res.on('close') -> stream.destroy()
  await sleep(60);
  assert.strictEqual(opened.length, 1); assert.strictEqual(closesOf(opened[0]), 1);
});

test('Lesefehler nach gesendeten Headern -> keine zweite res-Antwort, FD geschlossen', () => {
  reset();
  const realCRS = fs.createReadStream;
  let fake;
  fs.createReadStream = (p, opts) => { fake = new Readable({ read() {} }); fake.on('error', () => fs.close(opts.fd)); return fake; }; // mimt autoClose
  const res = mockRes(); res.headersSent = false;
  try {
    serveCloudFile(res, { diskPath: small, name: 'x', dbSize: 5 });
    const fd = opened[0];
    res.headersSent = true; // Header bereits geflossen
    fake.emit('error', new Error('read fail'));
    assert.strictEqual(res.statusCalls, 0, 'kein zweites res.status nach Headern');
    assert.strictEqual(res.destroyCalls, 1, 'res.destroy genau einmal');
    assert.strictEqual(closesOf(fd), 1, 'FD genau einmal geschlossen');
  } finally { fs.createReadStream = realCRS; }
});
