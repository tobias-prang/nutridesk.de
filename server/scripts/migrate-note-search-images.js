'use strict';
require('dotenv').config();
const mysql=require('mysql2/promise');
const pool=mysql.createPool({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'nutridesk',password:process.env.DB_PASS,database:process.env.DB_NAME||'nutridesk',connectionLimit:1});
(async()=>{for(const sql of['ALTER TABLE assistant_notes ADD COLUMN IF NOT EXISTS search_aliases_json TEXT NULL AFTER tags_json','ALTER TABLE assistant_note_images ADD COLUMN IF NOT EXISTS alt_text VARCHAR(500) NULL AFTER name','ALTER TABLE assistant_note_images ADD COLUMN IF NOT EXISTS caption VARCHAR(1000) NULL AFTER alt_text'])await pool.execute(sql);console.log('Notiz-Suchfelder und Bildmetadaten sind bereit.');await pool.end();})().catch(async e=>{console.error(e.message);await pool.end();process.exit(1);});
