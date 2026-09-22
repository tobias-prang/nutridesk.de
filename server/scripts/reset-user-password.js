'use strict';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const account = String(process.argv[2] || '').trim();
const password = String(process.env.RESET_PASSWORD || '');
if (!account || password.length < 8) {
  console.error('Aufruf: RESET_PASSWORD=... node scripts/reset-user-password.js konto');
  process.exit(1);
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'nutridesk',
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'nutridesk',
  connectionLimit: 2,
});

(async () => {
  const [users] = await pool.execute(
    `SELECT id, username, email, name
       FROM users
      WHERE LOWER(username)=LOWER(?)
         OR LOWER(email)=LOWER(?)
         OR LOWER(SUBSTRING_INDEX(email,'@',1))=LOWER(?)`,
    [account, account, account]);
  if (users.length !== 1) throw new Error(users.length ? 'Konto ist nicht eindeutig' : 'Konto nicht gefunden');
  const hash = await bcrypt.hash(password, 11);
  await pool.execute(
    'UPDATE users SET pass_hash=?, auth_version=auth_version+1 WHERE id=?',
    [hash, users[0].id]);
  console.log(JSON.stringify({ ok:true, id:users[0].id, username:users[0].username, email:users[0].email, name:users[0].name }));
})().catch(e => {
  console.error(e.message);
  process.exitCode = 1;
}).finally(() => pool.end());
