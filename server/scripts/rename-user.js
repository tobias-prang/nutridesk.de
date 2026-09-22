'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

const account = String(process.argv[2] || '').trim();
const username = String(process.argv[3] || '').trim().toLowerCase();
if (!account || !/^[a-z0-9._-]{3,40}$/.test(username)) {
  console.error('Aufruf: node scripts/rename-user.js konto neuer-benutzername');
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
    `SELECT id,username,email,name FROM users
      WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?) OR LOWER(SUBSTRING_INDEX(email,'@',1))=LOWER(?)`,
    [account, account, account]);
  if (users.length !== 1) throw new Error(users.length ? 'Konto ist nicht eindeutig' : 'Konto nicht gefunden');
  const [taken] = await pool.execute('SELECT id FROM users WHERE LOWER(username)=LOWER(?) AND id<>?', [username, users[0].id]);
  if (taken.length) throw new Error('Benutzername ist bereits vergeben');
  await pool.execute('UPDATE users SET username=? WHERE id=?', [username, users[0].id]);
  console.log(JSON.stringify({ ok:true, id:users[0].id, oldUsername:users[0].username, username }));
})().catch(e => {
  console.error(e.code === 'ER_DUP_ENTRY' ? 'Benutzername ist bereits vergeben' : e.message);
  process.exitCode = 1;
}).finally(() => pool.end());
