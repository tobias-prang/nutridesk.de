'use strict';

const crypto = require('crypto');

// Tagebuchdaten verwenden bewusst einen eigenen, vom JWT-Secret abgeleiteten
// Schluessel. Die Nutzer-ID wird als AAD gebunden, damit verschluesselte Inhalte
// nicht zwischen Konten verschoben und dort entschluesselt werden koennen.
function createJournalCrypto(secret) {
  const key = crypto.createHash('sha256').update(String(secret) + ':journal:v1').digest();

  function encrypt(userId, value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(String(userId) + ':journal:v1'));
    const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
  }

  function decrypt(userId, stored) {
    const parts = String(stored || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Ungueltiges Tagebuch-Chiffrat');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(Buffer.from(String(userId) + ':journal:v1'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  }

  return { encrypt, decrypt };
}

module.exports = { createJournalCrypto };
