'use strict';
require('dotenv').config();
const mysql=require('mysql2/promise');
const pool=mysql.createPool({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'nutridesk',password:process.env.DB_PASS,database:process.env.DB_NAME||'nutridesk',connectionLimit:1});

const categoryByTitle={
  'Begriffserklärungen – Kabel, TV & Technik':'TV-Wissen',
  'Netzebenen – was behandeln wir?':'Kabelnetz & Breitbandwissen',
  'TITAN – welcher Weg bei welchem Anliegen?':'Systeme',
  'TV-Störung – Schnellweg im Call':'Störung & Analyse',
  'Hardware erkennen – Multimedia-Dose & Adapter':'Kabelnetz & Breitbandwissen',
  'Router-Anschlüsse – FON, Cable, LAN, USB & Strom':'Kabelnetz & Breitbandwissen',
  'Vertrieb nach der Lösung – kurzer Leitfaden':'Vertrag & Angebot',
};

(async()=>{const conn=await pool.getConnection();try{
  await conn.execute('ALTER TABLE assistant_notes ADD COLUMN IF NOT EXISTS pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER search_aliases_json');
  await conn.beginTransaction();
  const [[user]]=await conn.execute('SELECT id FROM users WHERE LOWER(username)=LOWER(?)',['tobiasprang']);
  if(!user)throw new Error('Konto tobiasprang nicht gefunden');
  const [sections]=await conn.execute('SELECT id,title FROM assistant_note_sections WHERE user_id=?',[user.id]);
  const sectionByTitle=new Map(sections.map(s=>[s.title,Number(s.id)]));
  const [[legacy]]=await conn.execute("SELECT id FROM assistant_note_sections WHERE user_id=? AND (title='Verknüpft Wichtig' OR external_id='linked-important') LIMIT 1",[user.id]);
  let moved=0;
  if(legacy){
    const [oldNotes]=await conn.execute('SELECT id,title FROM assistant_notes WHERE user_id=? AND section_id=?',[user.id,legacy.id]);
    for(const note of oldNotes){const target=sectionByTitle.get(categoryByTitle[note.title]||'Grundlagen');if(!target)throw new Error('Zielkategorie fehlt: '+(categoryByTitle[note.title]||'Grundlagen'));await conn.execute('UPDATE assistant_notes SET section_id=?,pinned=1 WHERE id=? AND user_id=?',[target,note.id,user.id]);moved++;}
    await conn.execute('DELETE FROM assistant_note_sections WHERE id=? AND user_id=?',[legacy.id,user.id]);
  }
  const tkgSection=sectionByTitle.get('Lösung & Ticket');
  if(!tkgSection)throw new Error('Zielkategorie Lösung & Ticket fehlt');
  const [tkg]=await conn.execute("SELECT id,title FROM assistant_notes WHERE user_id=? AND (LOWER(title) LIKE '%entschädigung%' OR LOWER(content) LIKE '%entschädigung nach tkg%')",[user.id]);
  for(const note of tkg)await conn.execute('UPDATE assistant_notes SET section_id=?,pinned=1 WHERE id=? AND user_id=?',[tkgSection,note.id,user.id]);
  await conn.commit();console.log(JSON.stringify({ok:true,moved,pinnedTkg:tkg.map(n=>({id:n.id,title:n.title}))}));
}catch(e){await conn.rollback().catch(()=>{});throw e;}finally{conn.release();await pool.end();}})().catch(e=>{console.error(e.stack||e.message);process.exit(1);});
