'use strict';
// SEC-004B Upload-Validierung: Allowlist, Magic-Bytes, Struktur, Namen, Limits, Malware (EICAR).
// node --test tests/sec004b-upload.test.js   (benoetigt sharp + laufenden clamd fuer die Scan-Tests)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { validateUpload, sanitizeName, extOf, detectMagic } = require('../lib/upload-guard');
const { scanFile } = require('../lib/malware-scan');

const dir = path.join(os.tmpdir(), 'sec004b-' + process.pid);
fs.mkdirSync(dir, { recursive: true });
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });
let n = 0;
async function put(data) { const p = path.join(dir, 'f' + (n++)); await fsp.writeFile(p, data); return p; }
const V = (p, name) => validateUpload({ path: p, originalName: name, size: fs.statSync(p).size });

// --- minimaler Store-ZIP-Writer fuer OOXML-Fixtures ---
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function makeZip(files) {
  const local = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'); const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data); const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(data.length, 18); lfh.writeUInt32LE(data.length, 22); lfh.writeUInt16LE(name.length, 26);
    local.push(lfh, name, data);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6); cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(data.length, 20); cdh.writeUInt32LE(data.length, 24); cdh.writeUInt16LE(name.length, 28); cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);
    offset += 30 + name.length + data.length;
  }
  let cdSize = 0; for (const c of central) cdSize += c.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, eocd]);
}
const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>';
const docxOk = () => makeZip([{ name: '[Content_Types].xml', data: CT }, { name: '_rels/.rels', data: '<x/>' }, { name: 'word/document.xml', data: '<w/>' }]);

// ---- Namen ----
test('sanitizeName: Pfad-Traversal -> Basename', () => assert.strictEqual(sanitizeName('../../etc/passwd'), 'passwd'));
test('sanitizeName: CR/LF entfernt', () => assert.strictEqual(sanitizeName('a\r\nb.pdf'), 'ab.pdf'));
test('sanitizeName: Bidi-Override entfernt', () => { const s = sanitizeName('evil‮fdp.exe'); assert.ok(!/‮/.test(s)); assert.strictEqual(s, 'evilfdp.exe'); });
test('sanitizeName: reservierter Name CON.pdf', () => assert.strictEqual(sanitizeName('CON.pdf'), '_CON.pdf'));
test('sanitizeName: abschliessender Punkt', () => assert.strictEqual(sanitizeName('datei.'), 'datei'));
test('sanitizeName: Laenge <= 200', () => assert.ok(sanitizeName('x'.repeat(300) + '.pdf').length <= 200));
test('detectMagic: PE, ZIP, PDF', () => { assert.strictEqual(detectMagic(Buffer.from([0x4D, 0x5A])), 'pe'); assert.strictEqual(detectMagic(Buffer.from('PK\x03\x04')), 'zip'); assert.strictEqual(detectMagic(Buffer.from('%PDF-')), 'pdf'); });

// ---- Allowlist / Endung ----
test('EXE mit .jpg -> nicht dekodierbar/abgelehnt', async () => { const p = await put(Buffer.from('MZ\x90\x00' + '\x00'.repeat(64))); const r = await V(p, 'bild.jpg'); assert.strictEqual(r.ok, false); });
test('doppelte Endung rechnung.pdf.exe -> ext_not_allowed', async () => { const p = await put('%PDF-1.4\n%%EOF'); const r = await V(p, 'rechnung.pdf.exe'); assert.deepStrictEqual([r.ok, r.reason], [false, 'ext_not_allowed']); });
test('0-Byte-Datei -> empty', async () => { const p = await put(''); const r = await V(p, 'leer.pdf'); assert.deepStrictEqual([r.ok, r.reason], [false, 'empty']); });

// ---- PDF ----
test('gueltige PDF -> ok', async () => { const p = await put('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'); const r = await V(p, 'doc.pdf'); assert.deepStrictEqual([r.ok, r.detectedType], [true, 'pdf']); });
test('HTML mit .pdf -> type_mismatch', async () => { const p = await put('<html><body>hi</body></html>'); const r = await V(p, 'x.pdf'); assert.deepStrictEqual([r.ok, r.reason], [false, 'type_mismatch']); });
test('PDF mit JavaScript -> pdf_active_content', async () => { const p = await put('%PDF-1.4\n/JavaScript (app.alert(1))\n%%EOF'); const r = await V(p, 'js.pdf'); assert.deepStrictEqual([r.ok, r.reason], [false, 'pdf_active_content']); });
test('PDF mit EmbeddedFile -> pdf_active_content', async () => { const p = await put('%PDF-1.4\n/EmbeddedFile 2 0 R\n%%EOF'); const r = await V(p, 'emb.pdf'); assert.deepStrictEqual([r.ok, r.reason], [false, 'pdf_active_content']); });
test('verschluesselte PDF -> pdf_encrypted', async () => { const p = await put('%PDF-1.4\n/Encrypt 5 0 R\n%%EOF'); const r = await V(p, 'enc.pdf'); assert.deepStrictEqual([r.ok, r.reason], [false, 'pdf_encrypted']); });

// ---- Bilder ----
test('echtes PNG -> ok', async () => { const p = await put(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer()); const r = await V(p, 'foto.png'); assert.deepStrictEqual([r.ok, r.detectedType], [true, 'png']); });
test('echtes JPEG -> ok', async () => { const p = await put(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#abcdef' } }).jpeg().toBuffer()); const r = await V(p, 'foto.jpg'); assert.deepStrictEqual([r.ok, r.detectedType], [true, 'jpeg']); });
test('echtes WEBP -> ok', async () => { const p = await put(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0a0b0c' } }).webp().toBuffer()); const r = await V(p, 'foto.webp'); assert.strictEqual(r.ok, true); });
test('JPEG-Inhalt mit .png -> type_mismatch', async () => { const p = await put(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer()); const r = await V(p, 'x.png'); assert.deepStrictEqual([r.ok, r.reason], [false, 'type_mismatch']); });
test('SVG mit .png -> type_mismatch', async () => { const p = await put('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script></svg>'); const r = await V(p, 'v.png'); assert.deepStrictEqual([r.ok, r.reason], [false, 'type_mismatch']); });
test('beschaedigtes Bild -> image_undecodable', async () => { const good = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer(); const p = await put(good.slice(0, 20)); const r = await V(p, 'k.png'); assert.deepStrictEqual([r.ok, r.reason], [false, 'image_undecodable']); });
test('zu grosse Abmessungen -> image_dimensions', async () => { const p = await put(await sharp({ create: { width: 12001, height: 2, channels: 3, background: '#fff' } }).png().toBuffer()); const r = await V(p, 'big.png'); assert.deepStrictEqual([r.ok, r.reason], [false, 'image_dimensions']); });
test('zu viele Pixel -> image_pixels', async () => { const p = await put(await sharp({ create: { width: 6100, height: 6600, channels: 3, background: '#fff' } }).png().toBuffer()); const r = await V(p, 'pix.png'); assert.deepStrictEqual([r.ok, r.reason], [false, 'image_pixels']); });
test('PNG mit angehaengten Daten -> trailing_data', async () => { const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer(); const p = await put(Buffer.concat([png, Buffer.from('EXTRA-POLYGLOT')])); const r = await V(p, 'poly.png'); assert.deepStrictEqual([r.ok, r.reason], [false, 'trailing_data']); });

// ---- Text/CSV ----
test('gueltige TXT -> ok', async () => { const p = await put('Hallo Welt\nZeile zwei\n'); const r = await V(p, 'notiz.txt'); assert.strictEqual(r.ok, true); });
test('TXT mit Nullbyte -> binary_in_text', async () => { const p = await put(Buffer.from('abc\x00def')); const r = await V(p, 'n.txt'); assert.deepStrictEqual([r.ok, r.reason], [false, 'binary_in_text']); });
test('als .txt getarnte PDF -> type_mismatch', async () => { const p = await put('%PDF-1.4\n%%EOF'); const r = await V(p, 'fake.txt'); assert.deepStrictEqual([r.ok, r.reason], [false, 'type_mismatch']); });
test('CSV mit Formel -> ok aber csvFormula-Flag', async () => { const p = await put('name,wert\nfoo,=cmd|calc\n'); const r = await V(p, 'export.csv'); assert.strictEqual(r.ok, true); assert.strictEqual(r.csvFormula, true); });

// ---- OOXML ----
test('gueltige docx -> ok', async () => { const p = await put(docxOk()); const r = await V(p, 'brief.docx'); assert.deepStrictEqual([r.ok, r.detectedType], [true, 'docx']); });
test('ZIP als docx (kein Content_Types) -> ooxml_no_content_types', async () => { const p = await put(makeZip([{ name: 'random.txt', data: 'x' }])); const r = await V(p, 'fake.docx'); assert.deepStrictEqual([r.ok, r.reason], [false, 'ooxml_no_content_types']); });
test('docx-Struktur aber als xlsx benannt -> type_mismatch', async () => { const p = await put(docxOk()); const r = await V(p, 'tab.xlsx'); assert.deepStrictEqual([r.ok, r.reason], [false, 'type_mismatch']); });
test('Makro (vbaProject.bin) -> ooxml_macro', async () => { const p = await put(makeZip([{ name: '[Content_Types].xml', data: CT }, { name: 'word/document.xml', data: '<w/>' }, { name: 'word/vbaProject.bin', data: 'MZ' }])); const r = await V(p, 'makro.docx'); assert.deepStrictEqual([r.ok, r.reason], [false, 'ooxml_macro']); });
test('eingebettetes OLE -> ooxml_embedded', async () => { const p = await put(makeZip([{ name: '[Content_Types].xml', data: CT }, { name: 'word/document.xml', data: '<w/>' }, { name: 'word/embeddings/oleObject1.bin', data: 'x' }])); const r = await V(p, 'ole.docx'); assert.deepStrictEqual([r.ok, r.reason], [false, 'ooxml_embedded']); });
test('kein ZIP als docx -> ooxml_not_zip/corrupt', async () => { const p = await put('nur text, kein zip'); const r = await V(p, 'x.docx'); assert.strictEqual(r.ok, false); assert.ok(['ooxml_not_zip', 'ooxml_corrupt'].includes(r.reason)); });

// ---- Malware (EICAR) ----
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
test('Malware EICAR -> infected', async () => { const p = await put(EICAR); assert.strictEqual(await scanFile(p), 'infected'); });
test('saubere Datei -> clean', async () => { const p = await put('voellig harmlos'); assert.strictEqual(await scanFile(p), 'clean'); });
test('Scanner-Fehler (fehlende Datei) -> wirft, fail-closed', async () => { await assert.rejects(() => scanFile(path.join(dir, 'gibtsnicht')), /scanner_/); });
