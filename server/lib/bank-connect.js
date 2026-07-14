'use strict';
// SEC-001: Kapselt die Entscheidung, WELCHE URL der FinTS-Client bekommt, testbar.
// makeClient wird injiziert (real: new PinTanClient(...), Test: Spy). Der Client wird NUR
// gebaut, wenn die URL vollstaendig validiert ist, sonst wird makeClient nie aufgerufen.

const { resolveFintsUrl, validateFintsUrl } = require('./fints-url');

// Connect: URL kommt ausschliesslich aus der banks-Tabelle (resolveFintsUrl), kein Client-Input.
async function buildConnectClient({ pool, makeClient, blz, login, pin }) {
  const url = await resolveFintsUrl(pool, blz);
  const client = makeClient({ url, blz, name: login, pin });
  return { url, client };
}

// Sync: gespeicherte URL wird vor JEDER Nutzung voll neu validiert (Host kann jetzt privat aufloesen).
async function buildSyncClient({ makeClient, storedUrl, blz, login, pin }) {
  const url = await validateFintsUrl(storedUrl);
  const client = makeClient({ url, blz, name: login, pin });
  return { url, client };
}

module.exports = { buildConnectClient, buildSyncClient };
