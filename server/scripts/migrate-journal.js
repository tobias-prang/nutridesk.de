'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });
  await db.execute(`CREATE TABLE IF NOT EXISTS journal_entries (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    entry_date DATE NOT NULL,
    title_enc MEDIUMTEXT NOT NULL,
    content_enc LONGTEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_journal_user_date (user_id, entry_date, id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  const [rows] = await db.query("SHOW TABLES LIKE 'journal_entries'");
  await db.end();
  if (rows.length !== 1) throw new Error('journal_entries wurde nicht angelegt');
  process.stdout.write('journal_entries:ok\n');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
