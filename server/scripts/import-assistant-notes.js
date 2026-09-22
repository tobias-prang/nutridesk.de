'use strict';

require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2/promise');

const sourceFile = process.argv[2];
const account = String(process.argv[3] || '').trim();
if (!sourceFile || !account) {
  console.error('Aufruf: node scripts/import-assistant-notes.js data.json konto');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const icons = {
  'fas fa-thumbtack':'pin', 'fas fa-chart-line':'chart-no-axes-combined',
  'fas fa-route':'route', 'fas fa-comments':'messages-square', 'fas fa-lock':'lock-keyhole',
  'fas fa-magnifying-glass':'search', 'fas fa-screwdriver-wrench':'wrench',
  'fas fa-lightbulb':'lightbulb', 'fas fa-circle-check':'circle-check-big',
  'fas fa-users-gear':'users', 'fas fa-network-wired':'network',
  'fas fa-tv':'tv', 'fas fa-desktop':'monitor'
};

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'nutridesk', password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'nutridesk', connectionLimit: 2,
});

(async () => {
  const conn = await pool.getConnection();
  try {
    const [users] = await conn.execute(
      'SELECT id FROM users WHERE LOWER(name)=LOWER(?) OR LOWER(email)=LOWER(?) OR LOWER(SUBSTRING_INDEX(email,\'@\',1))=LOWER(?)',
      [account, account, account]);
    if (users.length !== 1) throw new Error(users.length ? 'Konto ist nicht eindeutig' : 'Konto nicht gefunden');
    const uid = users[0].id;
    await conn.beginTransaction();
    await conn.execute('DELETE FROM assistant_quick_notes WHERE user_id=?', [uid]);
    await conn.execute('DELETE FROM assistant_note_sections WHERE user_id=?', [uid]);
    const noteIds = new Map();
    let noteCount = 0;
    for (let si = 0; si < (data.sections || []).length; si++) {
      const section = data.sections[si];
      const [sr] = await conn.execute(
        'INSERT INTO assistant_note_sections (user_id,external_id,title,icon,sort_order) VALUES (?,?,?,?,?)',
        [uid, String(section.id).slice(0,100), String(section.title).slice(0,120), icons[section.icon] || 'folder', si]);
      for (let ni = 0; ni < (section.notes || []).length; ni++) {
        const note = section.notes[ni];
        const [nr] = await conn.execute(
          'INSERT INTO assistant_notes (user_id,section_id,external_id,title,content,tags_json,sort_order) VALUES (?,?,?,?,?,?,?)',
          [uid, sr.insertId, String(note.id).slice(0,120), String(note.title).slice(0,180), String(note.content || '').slice(0,50000), JSON.stringify((note.tags || []).slice(0,20)), ni]);
        noteIds.set(String(note.id), nr.insertId); noteCount++;
      }
    }
    for (const section of (data.sections || [])) for (const note of (section.notes || [])) {
      const from = noteIds.get(String(note.id));
      for (const externalRelated of (note.relatedNoteIds || [])) {
        const to = noteIds.get(String(externalRelated));
        if (from && to && from !== to) {
          await conn.execute('INSERT IGNORE INTO assistant_note_relations (user_id,note_id,related_id) VALUES (?,?,?)', [uid, from, to]);
          await conn.execute('INSERT IGNORE INTO assistant_note_relations (user_id,note_id,related_id) VALUES (?,?,?)', [uid, to, from]);
        }
      }
    }
    for (let i = 0; i < (data.quickNotes || []).length; i++) await conn.execute(
      'INSERT INTO assistant_quick_notes (user_id,text,sort_order) VALUES (?,?,?)', [uid, String(data.quickNotes[i]).slice(0,500), i]);
    await conn.commit();
    console.log(JSON.stringify({ account, sections:(data.sections || []).length, notes:noteCount, quickNotes:(data.quickNotes || []).length }));
  } catch (e) {
    await conn.rollback(); throw e;
  } finally {
    conn.release(); await pool.end();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
