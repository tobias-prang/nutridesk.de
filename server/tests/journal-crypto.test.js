'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJournalCrypto } = require('../lib/journal-crypto');

test('Tagebuch-Chiffrat enthaelt keinen Klartext und ist entschluesselbar', () => {
  const c = createJournalCrypto('test-secret');
  const plain = 'Ein sehr privater Tagebucheintrag';
  const encrypted = c.encrypt(17, plain);
  assert.match(encrypted, /^v1\./);
  assert.equal(encrypted.includes(plain), false);
  assert.equal(c.decrypt(17, encrypted), plain);
});

test('Tagebuch-Chiffrat ist an Nutzer und Auth-Tag gebunden', () => {
  const c = createJournalCrypto('test-secret');
  const encrypted = c.encrypt(17, 'privat');
  assert.throws(() => c.decrypt(18, encrypted));
  const tampered = encrypted.slice(0, -1) + (encrypted.endsWith('A') ? 'B' : 'A');
  assert.throws(() => c.decrypt(17, tampered));
});
