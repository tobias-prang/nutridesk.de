'use strict';
require('dotenv').config();
const mysql=require('mysql2/promise');
const pool=mysql.createPool({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'nutridesk',password:process.env.DB_PASS,database:process.env.DB_NAME||'nutridesk',connectionLimit:1});
const title='Kabel-TV-Glossar – die wichtigsten Begriffe';
const content=`CI+ (Common Interface Plus)
Schnittstelle am Fernseher für ein CI+-Modul. Das Modul nimmt die SmartCard auf und entschlüsselt gebuchte, verschlüsselte Sender. CI+ ist nicht selbst die Freischaltung.

CI+-Modul
Lesegerät zwischen Fernseher und SmartCard. Modul und SmartCard müssen technisch zusammenpassen.

SmartCard
Karte mit der Empfangsberechtigung für gebuchte TV-Pakete. Typische Karten sind D03/D08 oder G02/G09. Bei Fehlern Sitz, Zuordnung und Freischaltung prüfen.

CA-System (Conditional Access)
Zugangssystem für verschlüsselte Sender. Es prüft, ob für SmartCard beziehungsweise Gerät eine gültige Berechtigung vorliegt.

DVB-C / C-Tuner
Digitaler Fernsehempfang über Kabel. Der DVB-C-Tuner im TV oder Receiver verarbeitet das Kabelsignal und führt den Sendersuchlauf aus.

MMD (Multimedia-Dose)
Anschlussdose in der Wohnung. TV/Radio führen das Rundfunksignal; DATA wird für Kabelrouter, Internet und Telefon verwendet.

CONNECT / KAA
TV-Grundvertrag beziehungsweise Zugang zum Kabel-Grundsignal und zu unverschlüsselten Programmen.

KAD
Zusatzvertrag für verschlüsselte Sender oder TV-Pakete, zum Beispiel Basic HD, Premium HD oder Sprachpakete.

Free-TV / Pay-TV
Free-TV ist ohne zusätzliches Programmpaket empfangbar. Pay-TV ist verschlüsselt und benötigt Buchung plus passende Freischaltung.

SD / HD
SD ist Standardauflösung, HD eine höhere Bildauflösung. Private Sender sind im Kabel typischerweise in SD frei, in HD jedoch verschlüsselt. Öffentlich-rechtliche HD-Sender gehören grundsätzlich zum freien Empfang.

Basic HD / Premium HD / Premium Plus
Basic HD schaltet vor allem private HD-Sender frei. Premium HD und Premium Plus enthalten zusätzliche Pay-TV-Sender.

Freischaltsignal
Überträgt die gebuchte Berechtigung an SmartCard oder Empfangsgerät. Dafür muss das Gerät korrekt angeschlossen, eingeschaltet und auf einem passenden verschlüsselten Sender stehen.

Hinweis 3/303
SmartCard fehlt oder sitzt nicht richtig. Karte und Einsteckrichtung prüfen.

Hinweis 10/310
Keine passende Senderberechtigung. Buchung, Geräte-/SmartCard-Zuordnung und Freischaltsignal prüfen.

Pegel, MER und BER
Pegel beschreibt die Signalstärke. MER bewertet die Signalqualität; höher ist grundsätzlich besser. BER beschreibt Bitfehler; niedriger ist besser. Zusammen helfen die Werte, Signalstörungen einzugrenzen.

Rückweg / Rückkanal
Überträgt Daten vom Kabelmodem zurück ins Netz und ist für Internet und Telefon wichtig. Rückwegstörer können mehrere Anschlüsse in einem Gebiet beeinträchtigen.

Kurzdiagnose im Call
1. Betrifft es einen oder alle Sender?
2. Frei empfangbar oder verschlüsselt?
3. Welche Meldung beziehungsweise welcher Fehlercode erscheint?
4. Welches Gerät, Modul und welche SmartCard werden genutzt?
5. Ist das Paket gebucht und die Hardware korrekt zugeordnet?
6. Signalweg, Verkabelung, Suchlauf und Freischaltung prüfen.`;
const tags=['Glossar','Kabel-TV','CI+','SmartCard','DVB-C','MMD','KAA','KAD','CA-System','Freischaltung','Pegel','MER','BER'];
const aliases=['was ist ci plus','ci plus erklärung','tv begriffe','kabel tv abkürzungen','common interface plus','smart card','conditional access','c tuner','multimedia dose'];
const relatedTitles=['CA-System (Conditional Access) – Zugang & Hinweis 10/310','SmartCard / CI+ – Hinweis- und Fehlercodes','CI+ Module & passende SmartCards','Hinweis 10/310 – CA-System prüfen','Grundvertrag: CONNECT / KAA & Grundsignal','KAD – Zusatzverträge für verschlüsselte Sender','TV – Buchung & Zugang: KAA, KAD und CA-System','DVB & Tuner: DVB-C, DVB-S, DVB-T','MMD: TV, Internet & Zusatzverträge im Überblick','Grundsignal vs. Freischaltung / Zusatz-TV'];
(async()=>{const conn=await pool.getConnection();try{await conn.beginTransaction();const [[u]]=await conn.execute('SELECT id FROM users WHERE LOWER(username)=LOWER(?)',['tobiasprang']);if(!u)throw new Error('Konto tobiasprang nicht gefunden');const [[section]]=await conn.execute('SELECT id FROM assistant_note_sections WHERE user_id=? AND title=?',[u.id,'TV-Wissen']);if(!section)throw new Error('Bereich TV-Wissen nicht gefunden');let [[note]]=await conn.execute('SELECT id FROM assistant_notes WHERE user_id=? AND title=?',[u.id,title]);if(note){await conn.execute('UPDATE assistant_notes SET section_id=?,content=?,tags_json=?,search_aliases_json=? WHERE id=?',[section.id,content,JSON.stringify(tags),JSON.stringify(aliases),note.id]);}else{const [[m]]=await conn.execute('SELECT COALESCE(MAX(sort_order),-1)+1 n FROM assistant_notes WHERE user_id=? AND section_id=?',[u.id,section.id]);const [r]=await conn.execute('INSERT INTO assistant_notes (user_id,section_id,title,content,tags_json,search_aliases_json,sort_order) VALUES (?,?,?,?,?,?,?)',[u.id,section.id,title,content,JSON.stringify(tags),JSON.stringify(aliases),m.n]);note={id:r.insertId};}await conn.execute('DELETE FROM assistant_note_relations WHERE user_id=? AND (note_id=? OR related_id=?)',[u.id,note.id,note.id]);const marks=relatedTitles.map(()=>'?').join(',');const [targets]=await conn.execute(`SELECT id FROM assistant_notes WHERE user_id=? AND title IN (${marks})`,[u.id,...relatedTitles]);for(const target of targets){await conn.execute('INSERT IGNORE INTO assistant_note_relations (user_id,note_id,related_id) VALUES (?,?,?)',[u.id,note.id,target.id]);await conn.execute('INSERT IGNORE INTO assistant_note_relations (user_id,note_id,related_id) VALUES (?,?,?)',[u.id,target.id,note.id]);}await conn.commit();console.log(JSON.stringify({ok:true,noteId:note.id,relations:targets.length}));}catch(e){await conn.rollback();throw e;}finally{conn.release();await pool.end();}})().catch(e=>{console.error(e.stack||e.message);process.exit(1);});
