'use strict';
// SEC-004A: Sichere Cloud-Datei-Auslieferung. IMMER Download (kein inline), IMMER application/octet-stream
// (kein client-gesetzter MIME), sichere Oeffnung (O_NOFOLLOW + fstat: nur regulaere Datei, Groesse == DB),
// harte Sicherheits-Header, CRLF-sicherer Content-Disposition (UTF-8 + ASCII-Fallback).

const fs = require('fs');
const contentDisposition = require('content-disposition');

// Produktionsserver ist Linux; O_NOFOLLOW ist dort verfuegbar. Fail-closed: KEIN stiller Fallback auf O_RDONLY
// (sonst waere die Symlink-Sicherung lautlos deaktiviert).
if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
  throw new Error('O_NOFOLLOW wird für sichere Cloud-Downloads benötigt');
}
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

function fail404(res) { if (!res.headersSent) res.status(404).json({ error: 'Datei nicht verfügbar' }); }

function serveCloudFile(res, opts) {
  const diskPath = opts && opts.diskPath;
  const name = (opts && opts.name) || 'datei';
  const dbSize = opts && opts.dbSize;
  let fd;
  try { fd = fs.openSync(diskPath, OPEN_FLAGS); } catch (e) { return fail404(res); } // Symlink/fehlend -> 404
  try {
    const st = fs.fstatSync(fd);
    // Nur regulaere Datei (kein Verzeichnis/Symlink/Device/Socket) und Groesse == DB-Metadatum.
    if (!st.isFile() || (dbSize != null && Number(st.size) !== Number(dbSize))) { fs.closeSync(fd); return fail404(res); }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(String(name).slice(0, 200)));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (typeof res.vary === 'function') res.vary('Authorization'); // ergaenzt vorhandene Vary-Werte (z.B. Origin)
    else res.setHeader('Vary', 'Authorization');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Length', String(st.size));
    // FD-Lebenszyklus: der Stream schliesst den fd genau EINMAL (autoClose) bei Ende/Fehler/destroy.
    const stream = fs.createReadStream(diskPath, { fd, autoClose: true }); // streamt ueber den geprueften fd
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    res.on('close', () => stream.destroy()); // Client-Abbruch: Stream (und via autoClose der fd) schliessen
    stream.pipe(res);
  } catch (e) { try { fs.closeSync(fd); } catch (x) {} return fail404(res); }
}

module.exports = { serveCloudFile };
