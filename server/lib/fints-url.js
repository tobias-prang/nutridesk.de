'use strict';
// SEC-001: FinTS-Ziel-URL wird AUSSCHLIESSLICH serverseitig aus der banks-Tabelle bestimmt.
// Policy: NUR global routbare Unicast-IPs sind zulaessig. Alles andere (Loopback, privat,
// Link-Local, Unique-Local, Site-Local, Multicast, Unspecified, Reserved, Benchmark,
// Dokumentation, IPv4-mapped/-kompatible private Adressen, Cloud-Metadaten) wird abgelehnt.
// IP-Parsing/Klassifizierung ueber ipaddr.js (fest gepinnt) + explizite Blockliste fuer Faelle,
// die ipaddr.js faelschlich als 'unicast' einstuft. Keine wachsende eigene Regex-Loesung.

const dns = require('dns').promises;
const ipaddr = require('ipaddr.js');

const codedError = (code) => Object.assign(new Error(code), { code });

// Nur https-Standardport. Dokumentierte Allowlist: '' (Default 443) und '443'.
const ALLOWED_PORTS = new Set(['', '443']);

// Bereiche, die ipaddr.js range() nicht als nicht-routbar erkennt -> explizit sperren.
const EXTRA_BLOCK = [
  '198.18.0.0/15',   // IPv4 Benchmark (RFC2544)
  'fec0::/10',       // IPv6 Site-Local (deprecated)
  '2001:db8::/32',   // IPv6 Dokumentation
  '3fff::/20',       // IPv6 Dokumentation (RFC9637)
  '2001:20::/28',    // ORCHIDv2
  '100::/64',        // Discard-Only
  '5f00::/16',       // Segment Routing (reserviert)
].map((c) => ipaddr.parseCIDR(c));

function matchAny(addr, cidrList) {
  return cidrList.some((c) => { try { return addr.match(c); } catch (e) { return false; } });
}

// true = gesperrt (nicht global routbares Unicast). Unparsebar -> gesperrt (fail closed).
function isBlockedIp(addrStr) {
  let a;
  try { a = ipaddr.parse(String(addrStr)); } catch (e) { return true; }
  if (a.kind() === 'ipv4') {
    return a.range() !== 'unicast' || matchAny(a, EXTRA_BLOCK);
  }
  // IPv6
  if (a.range() === 'ipv4Mapped') return isBlockedIp(a.toIPv4Address().toString());
  const bytes = a.toByteArray();
  // ::/96 (unspecified, loopback, IPv4-kompatibel) -> eingebettete IPv4 klassifizieren
  if (bytes.slice(0, 12).every((b) => b === 0)) {
    return isBlockedIp(ipaddr.fromByteArray(bytes.slice(12)).toString());
  }
  if (matchAny(a, EXTRA_BLOCK)) return true;
  return a.range() !== 'unicast';
}

// Einzige URL-Validierung. Async, weil DNS aufgeloest wird. Gibt normalisierte URL zurueck.
async function validateFintsUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw codedError('empty_url');
  let u;
  try { u = new URL(rawUrl.trim()); } catch (e) { throw codedError('invalid_url'); }
  if (u.protocol !== 'https:') throw codedError('not_https');
  if (u.username || u.password) throw codedError('userinfo_not_allowed');
  if (!ALLOWED_PORTS.has(u.port)) throw codedError('port_not_allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host)) {
    if (isBlockedIp(host)) throw codedError('blocked_host');
  } else {
    const hl = host.toLowerCase();
    if (hl === 'localhost' || hl.endsWith('.localhost') || hl.endsWith('.local') ||
        hl.endsWith('.internal') || hl.endsWith('.lan')) throw codedError('blocked_host');
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { throw codedError('dns_failed'); }
  if (!addrs || !addrs.length) throw codedError('dns_failed');
  for (const x of addrs) if (isBlockedIp(x.address)) throw codedError('resolves_to_blocked_ip');
  return u.toString();
}

// Aufloesung NUR aus der banks-Tabelle (kein Client-Input). Schlaegt geschlossen fehl.
async function resolveFintsUrl(pool, blz) {
  const [[row]] = await pool.execute(
    'SELECT fints_url FROM banks WHERE blz = ? AND fints_url IS NOT NULL AND fints_url <> \'\' ORDER BY CHAR_LENGTH(name) LIMIT 1',
    [String(blz)]);
  if (!row || !row.fints_url) throw codedError('no_bank_url');
  return validateFintsUrl(row.fints_url);
}

module.exports = { validateFintsUrl, resolveFintsUrl, isBlockedIp };
