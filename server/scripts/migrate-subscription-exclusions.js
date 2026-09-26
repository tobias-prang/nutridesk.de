'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'nutridesk',
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'nutridesk',
  connectionLimit: 1
});

(async () => {
  await pool.execute('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS exclude_from_totals TINYINT(1) NOT NULL DEFAULT 0 AFTER auto_book');
  console.log('Abo-Ausnahme für Finanzsummen ist bereit.');
  await pool.end();
})().catch(async error => {
  console.error(error.message);
  await pool.end();
  process.exit(1);
});
