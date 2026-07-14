'use strict';
// SEC-004A echte Endpoint-Tests: reale Express-Route -> serveCloudFile mit echten Temp-Dateien.
// node --test tests/sec004a-cloud-download.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serveCloudFile } = require('../lib/cloud-download');

const root = path.join(os.tmpdir(), 'sec004a-' + process.pid);
const userDir = path.join(root, '7');
fs.mkdirSync(userDir, { recursive: true });
const w = (nm, data) => { const p = path.join(userDir, nm); fs.writeFileSync(p, data); return Buffer.byteLength(data); };

// Kuenstliche Testdateien (stored_name = fingierte UUID). Groesse = echte Bytegroesse.
const FILES = {
  1: { stored_name: 'u-html', name: 'seite.html', size: w('u-html', '<html><script>alert(1)</script></html>') },
  2: { stored_name: 'u-svg', name: 'bild.svg', size: w('u-svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>') },
  3: { stored_name: 'u-js', name: 'x.js', size: w('u-js', 'alert(document.cookie)') },
  4: { stored_name: 'u-pdf', name: 'doc.pdf', size: w('u-pdf', '%PDF-1.4\n1 0 obj<<>>endobj') },
  5: { stored_name: 'u-png', name: 'foto.png', size: w('u-png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])) },
  6: { stored_name: 'u-bin', name: 'file.bin', size: w('u-bin', 'irgendwas') },
  7: { stored_name: 'u-crlf', name: 'a\r\nInjected-Header: evil', size: w('u-crlf', 'x') },
  8: { stored_name: 'u-uni', name: 'Vertrag_' + String.fromCharCode(0x6587) + '.pdf', size: w('u-uni', 'x') }, // CJK erzwingt filename*
  9: { stored_name: 'u-sz', name: 'mismatch', size: 99999 }, // DB behauptet falsche Groesse
  10: { stored_name: 'u-missing', name: 'weg' },              // keine physische Datei
};
w('u-sz', 'abc'); // reale 3 Bytes != 99999
try { fs.symlinkSync('/etc/hostname', path.join(userDir, 'u-link')); } catch (e) {}
FILES[11] = { stored_name: 'u-link', name: 'link' };          // Symlink
fs.mkdirSync(path.join(userDir, 'u-dir'), { recursive: true });
FILES[12] = { stored_name: 'u-dir', name: 'dir' };            // Verzeichnis
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} });

const app = express();
app.get('/cloud/file/:id', (req, res) => {
  const f = FILES[req.params.id];                            // fremde id -> nicht vorhanden -> 404 (keine Oeffnung)
  if (!f) return res.status(404).json({ error: 'nf' });
  serveCloudFile(res, { diskPath: path.join(userDir, f.stored_name), name: f.name, dbSize: f.size });
});
function get(id, query) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      const r = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/cloud/file/' + id + (query || ''), method: 'GET', headers: { Authorization: 'Bearer x' } },
        (resp) => { let b = Buffer.alloc(0); resp.on('data', (c) => (b = Buffer.concat([b, c]))); resp.on('end', () => { srv.close(); resolve({ status: resp.statusCode, h: resp.headers, len: b.length }); }); });
      r.on('error', (e) => { srv.close(); reject(e); }); r.end();
    });
  });
}
const assertSecure = (r) => {
  assert.strictEqual(r.h['content-type'], 'application/octet-stream');
  assert.ok(/^attachment/.test(r.h['content-disposition'] || ''), 'attachment erwartet: ' + r.h['content-disposition']);
  assert.strictEqual(r.h['x-content-type-options'], 'nosniff');
  assert.strictEqual(r.h['cache-control'], 'private, no-store');
  assert.ok(/Authorization/.test(r.h['vary'] || ''));
};

for (const [id, label] of [[1, 'HTML'], [2, 'SVG'], [3, 'JS'], [4, 'PDF'], [5, 'PNG'], [6, 'unbekannt']]) {
  test('ENDPOINT ' + label + ' -> octet-stream + attachment + nosniff', async () => { const r = await get(id); assert.strictEqual(r.status, 200); assertSecure(r); });
}
test('ENDPOINT PDF mit ?inline=1 -> weiterhin attachment', async () => { const r = await get(4, '?inline=1'); assert.strictEqual(r.status, 200); assertSecure(r); });
test('ENDPOINT PNG mit ?inline=1 -> weiterhin attachment', async () => { const r = await get(5, '?inline=1'); assert.strictEqual(r.status, 200); assertSecure(r); });
test('ENDPOINT Dateiname mit CR/LF -> keine Header-Injection', async () => { const r = await get(7); assert.strictEqual(r.status, 200); assert.strictEqual(r.h['injected-header'], undefined); assert.ok(!/[\r\n]/.test(r.h['content-disposition'])); });
test('ENDPOINT Unicode-Name -> gueltiger Content-Disposition (filename*)', async () => { const r = await get(8); assert.strictEqual(r.status, 200); assert.ok(/filename\*/.test(r.h['content-disposition'])); });
test('ENDPOINT Groessen-Mismatch -> 404', async () => { const r = await get(9); assert.strictEqual(r.status, 404); });
test('ENDPOINT fehlende physische Datei -> 404', async () => { const r = await get(10); assert.strictEqual(r.status, 404); });
test('ENDPOINT Symlink statt regulaerer Datei -> 404', async () => { const r = await get(11); assert.strictEqual(r.status, 404); });
test('ENDPOINT Verzeichnis statt Datei -> 404', async () => { const r = await get(12); assert.strictEqual(r.status, 404); });
test('ENDPOINT fremde file_id -> 404 (keine Datei geoeffnet)', async () => { const r = await get(9999); assert.strictEqual(r.status, 404); });

test('VARY: bestehender Origin bleibt erhalten + Authorization ergaenzt', async () => {
  const app2 = express();
  app2.get('/cloud/file/:id', (req, res) => { res.setHeader('Vary', 'Origin'); serveCloudFile(res, { diskPath: path.join(userDir, FILES[6].stored_name), name: FILES[6].name, dbSize: FILES[6].size }); });
  const r = await new Promise((resolve, reject) => { const srv = app2.listen(0, () => { const rq = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/cloud/file/6', method: 'GET' }, (resp) => { resp.on('data', () => {}); resp.on('end', () => { srv.close(); resolve({ status: resp.statusCode, vary: resp.headers['vary'] }); }); }); rq.on('error', (e) => { srv.close(); reject(e); }); rq.end(); }); });
  assert.strictEqual(r.status, 200);
  const parts = String(r.vary || '').split(',').map((s) => s.trim().toLowerCase());
  assert.ok(parts.includes('origin') && parts.includes('authorization'), 'Vary=' + r.vary);
});

test('O_NOFOLLOW fail-closed: kein "|| 0" Fallback, throw-Guard vorhanden; Modul wirft ohne Konstante', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cloud-download.js'), 'utf8');
  assert.ok(!/O_NOFOLLOW\s*\|\|\s*0/.test(src), 'unsicherer "|| 0"-Fallback vorhanden');
  assert.ok(/Number\.isInteger\(fs\.constants\.O_NOFOLLOW\)/.test(src) && /throw new Error/.test(src), 'Fail-closed-Guard fehlt');
  const descr = Object.getOwnPropertyDescriptor(fs.constants, 'O_NOFOLLOW');
  if (descr && descr.configurable) {
    delete require.cache[require.resolve('../lib/cloud-download')];
    try {
      Object.defineProperty(fs.constants, 'O_NOFOLLOW', { value: undefined, configurable: true });
      assert.throws(() => require('../lib/cloud-download'), /O_NOFOLLOW/); // fail-closed, kein O_RDONLY-Fallback
    } finally {
      Object.defineProperty(fs.constants, 'O_NOFOLLOW', descr);
      delete require.cache[require.resolve('../lib/cloud-download')];
      require('../lib/cloud-download');
    }
  }
});
