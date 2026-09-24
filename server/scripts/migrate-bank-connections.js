'use strict';
require('dotenv').config();
const mysql=require('mysql2/promise');

(async()=>{
  const db=await mysql.createConnection({
    host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),
    user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME||'nutridesk',
  });
  try{
    const [cols]=await db.query("SHOW COLUMNS FROM bank_connections LIKE 'id'");
    if(cols.length){console.log('bank_connections ist bereits migriert');return;}
    await db.query('CREATE TABLE IF NOT EXISTS bank_connections_backup_20260924 LIKE bank_connections');
    const [[backup]]=await db.query('SELECT COUNT(*) AS n FROM bank_connections_backup_20260924');
    if(!Number(backup.n))await db.query('INSERT INTO bank_connections_backup_20260924 SELECT * FROM bank_connections');
    await db.query('ALTER TABLE bank_connections DROP PRIMARY KEY, ADD COLUMN id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST, ADD KEY idx_bank_connections_user (user_id), ADD UNIQUE KEY uq_bank_connections_login (user_id, blz, login)');
    console.log('bank_connections erfolgreich auf mehrere Verbindungen migriert');
  }finally{await db.end();}
})().catch(e=>{console.error(e);process.exit(1);});
