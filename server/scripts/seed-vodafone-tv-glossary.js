'use strict';
require('dotenv').config();
const mysql=require('mysql2/promise');
const pool=mysql.createPool({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'nutridesk',password:process.env.DB_PASS,database:process.env.DB_NAME||'nutridesk',connectionLimit:1});

const notes=[
  {key:'important-glossary',title:'Begriffserklärungen – Kabel, TV & Technik',tags:['Wichtig','Glossar','CI+','SmartCard','DVB-C','MMD','KAA','KAD'],aliases:['was ist ci plus','smart card','tv begriffe','kabel abkürzungen'],related:['CA-System (Conditional Access) – Zugang & Hinweis 10/310','SmartCard / CI+ – Hinweis- und Fehlercodes','CI+ Module & passende SmartCards','DVB & Tuner: DVB-C, DVB-S, DVB-T','MMD: TV, Internet & Zusatzverträge im Überblick'],content:`CI+ (Common Interface Plus)
Schnittstelle am Fernseher für ein CI+-Modul. Das Modul nimmt die SmartCard auf und entschlüsselt gebuchte Sender. CI+ ist nicht selbst die Freischaltung.

CI+-Modul
Lesegerät zwischen Fernseher und SmartCard. Modul und Karte müssen zusammenpassen.

SmartCard
Trägt die Empfangsberechtigung für gebuchte TV-Pakete. Bei Fehlern Sitz, Zuordnung und Freischaltung prüfen.

CA-System (Conditional Access)
Prüft, ob für SmartCard oder Empfangsgerät eine gültige Berechtigung für den verschlüsselten Sender vorliegt.

DVB-C / C-Tuner
Digitaler Fernsehempfang über Kabel. Der C-Tuner verarbeitet das Kabelsignal und führt den Sendersuchlauf aus.

MMD (Multimedia-Dose)
Anschlussdose: TV für Fernsehen, R für Radio, DATA für Kabelrouter/Internet/Telefon.

CONNECT / KAA
TV-Grundvertrag und Zugang zum Kabel-Grundsignal beziehungsweise zu unverschlüsselten Programmen.

KAD
Zusatzvertrag für verschlüsselte Sender oder Pakete, zum Beispiel Basic HD oder Premium HD.

Free-TV / Pay-TV
Free-TV ist ohne zusätzliches Programmpaket verfügbar. Pay-TV ist verschlüsselt und benötigt Buchung plus Freischaltung.

SD / HD
Private Sender sind im Kabel typischerweise in SD frei, in HD verschlüsselt. Öffentlich-rechtliche HD-Sender gehören grundsätzlich zum freien Empfang.

Freischaltsignal
Überträgt die Berechtigung an SmartCard oder Gerät. Empfänger korrekt anschließen, einschalten und auf einem passenden verschlüsselten Sender stehen lassen.

Pegel / MER / BER
Pegel = Signalstärke. MER = Signalqualität, höher ist grundsätzlich besser. BER = Bitfehlerrate, niedriger ist besser.

Rückweg / Rückkanal
Datenweg vom Kabelmodem zurück ins Netz; wichtig für Internet und Telefonie. Ein Rückwegstörer kann mehrere Anschlüsse beeinträchtigen.`},
  {key:'important-network-levels',title:'Netzebenen – was behandeln wir?',tags:['Wichtig','NE3','NE4','NE5','Zuständigkeit','Techniker'],aliases:['welche netzebenen behandeln wir','netzebene zuständig','eigenverschulden'],related:['Haftung: NE3-Service & NE4-Service','Signalbeeinträchtigung NE3–NE5: Pixel, Klötzchen & Bildaussetzer','Technischer Außendienst & Servicepauschale','Übergabepunkt (ÜP) & Hausverteilung'],content:`SCHNELLANTWORT
NE3 behandeln wir. NE4 behandeln wir, wenn für das Objekt NE4-Service beziehungsweise eine entsprechende Vereinbarung besteht. Bei kundeneigenem Anschlussmaterial oder Eigenverschulden liegt der Fehler regelmäßig in NE5; dann können Kosten entstehen. TITAN und die aktuelle Objekt-/Vertragsanzeige bleiben verbindlich.

NE1 – Produktion / Sender
Inhalte entstehen beim Sender oder Programmlieferanten. Bei einem zentral fehlenden Programm kann die Ursache bereits hier liegen.

NE2 – Backbone / Kopfstelle / Transport
Transport und Aufbereitung der Signale. Größere oder bekannte Ausfälle können über Netzüberwachung beziehungsweise TITAN sichtbar sein.

NE3 – öffentliches Verteilnetz bis Übergabepunkt (ÜP)
BEHANDELN WIR. Dazu gehören Verteilerpunkte, Straßenverteilung und der Signalweg bis zum Gebäude-Übergabepunkt. Standard-Haftung: NE3-Service bis ÜP.

NE4 – Hausverteilnetz ab ÜP bis Anschlussdose/MMD
BEHANDELN WIR, WENN NE4-SERVICE/VEREINBARUNG VORLIEGT. Beispiele: Hausverstärker, Abzweiger, Hausleitungen und Anschlussdose. Ohne entsprechende Vereinbarung kann Eigentümer/Vermieter zuständig sein. Immer Objektstatus in TITAN prüfen.

NE5 – kundeneigener Bereich ab Anschlussdose
In der Regel Kunde: Koax-/Antennenkabel, T-Stück, Verlängerung, eigener Fernseher, Receiver, Router oder sonstige Endgeräte.

AUSNAHME EIGENVERSCHULDEN / KUNDENBEREICH
Kosten können entstehen, wenn der Außendienst feststellt, dass die Ursache beim Kunden liegt, zum Beispiel:
• defektes oder schlecht abgeschirmtes Antennenkabel
• loses Kabel, falscher Anschluss oder T-Stück
• kundeneigener Verstärker/Adapter
• Fernseher, Receiver oder Router des Kunden
• beschädigte Dose/Leitung durch den Kunden

IM CALL
1. Störungsbild und betroffene Dienste klären.
2. Verkabelung und kundeneigene Geräte eingrenzen.
3. Objektstatus/NE4-Service in TITAN prüfen.
4. Vorgesehenen TITAN-Weg vollständig abarbeiten.
5. Vor Außendienst transparent über möglichen Kostenfall bei Kundenursache informieren – nicht pauschal Kosten versprechen.`},
  {key:'important-titan-router',title:'TITAN – welcher Weg bei welchem Anliegen?',tags:['Wichtig','TITAN','Routing','Störung','TV','Internet','Telefon'],aliases:['wo muss ich in titan hin','titan weg','kunde hat problem mit tv'],related:['TITAN – Hilfetool bei der Problemlösung','Störung bearbeiten','Internet – typische Beeinträchtigungen','SmartCard / CI+ – Hinweis- und Fehlercodes'],content:`GRUNDREGEL
Nicht raten: erst Anliegen und Fehlerbild klären, dann den passenden TITAN-Use-Case vollständig abarbeiten. Die aktuelle TITAN-Auswahl ist verbindlicher als diese Merkhilfe.

KUNDE HAT EIN PROBLEM MIT TV
→ TV-Beeinträchtigung
→ Bild/Ton/Sender oder angezeigten Hinweis auswählen
→ alle oder nur einzelne Sender eingrenzen
→ frei empfangbar oder verschlüsselt unterscheiden
→ Verkabelung, Gerät, Signal und ggf. CA-System nach TITAN prüfen

TV-APP ODER MEDIATHEK FUNKTIONIERT NICHT
→ TV-Zusatzfunktionen / Mediathek

NEUES TV-GERÄT / NEUE HARDWARE FUNKTIONIERT NICHT
→ Installation / Einrichtung
→ Aktivierungscode/Freischaltung und Gerätezuordnung prüfen

JUGENDSCHUTZ-PIN
→ TV-Beeinträchtigung → Jugendschutz-PIN

VERSCHLÜSSELTER SENDER / CI+ / SMARTCARD
→ TV-Beeinträchtigung → angezeigten Hinweis auswählen
→ 3/303: Karte fehlt oder sitzt falsch
→ 10/310: Berechtigung/Freischaltung fehlt
→ 320: Karte nicht lesbar
→ Modul, Karte, Buchung und Zuordnung prüfen

INTERNET KOMPLETT AUS / ABBRÜCHE
→ Internet-Beeinträchtigung
→ Modemstatus, Signal und bekannte Störung prüfen
→ bei Ausfall gegebenenfalls AlwaysOn nach Prozess prüfen

INTERNET LANGSAM
→ Internet-Beeinträchtigung → Bandbreite / langsames Internet
→ LAN vor WLAN, laufende Anwendungen und Endgerät eingrenzen
→ Signalproblem, Provisionierung, echte BBB oder Heimnetz unterscheiden

TELEFON FUNKTIONIERT NICHT
→ Telefon-Beeinträchtigung
→ ein-/ausgehend, einzelne/alle Rufnummern und Modem/Endgerät eingrenzen

APP-/SYSTEMPROBLEM
→ passenden App-/System-Use-Case wählen; nicht als Netzstörung behandeln, wenn der Dienst selbst funktioniert.

ABSCHLUSS
Ergebnis dokumentieren, Lösung/Nächste Schritte erklären, bestätigen lassen und erst danach Vertragslage beziehungsweise Verkaufschance prüfen.`},
  {key:'important-tv-flow',title:'TV-Störung – Schnellweg im Call',tags:['Wichtig','TV','Störung','Call-Flow','Fehlercode'],aliases:['tv geht nicht','kein bild','sender fehlen','pixel klötzchen'],related:['Fragetechnik bei der Störungsanalyse','TV-Frequenzen & Sonderkanäle – S24 / S26 / S39','Hinweis 10/310 – CA-System prüfen','Grundsignal vs. Freischaltung / Zusatz-TV'],content:`1. FEHLERBILD
„Was genau sehen Sie auf dem Bildschirm?“
• kein Bild / schwarzer Bildschirm
• Pixel, Klötzchen, Standbild oder Aussetzer
• Sender fehlt
• Hinweis-/Fehlercode
• nur App/Mediathek betroffen

2. UMFANG
• alle Sender oder einzelne?
• seit wann und dauerhaft oder zeitweise?
• mehrere TV-Geräte betroffen?

3. SENDERART
• öffentlich-rechtlich / frei empfangbar
• privater Sender in SD
• privater HD- oder Pay-TV-Sender / verschlüsselt
Nur verschlüsselte Sender betroffen → Buchung, SmartCard/CI+ und Freischaltung prüfen.

4. SIGNALWEG
MMD/TV-Ausgang → Koaxialkabel → TV/Receiver → DVB-C-Tuner.
Kabel fest? T-Stück/Verlängerung testweise entfernen? Richtiger Eingang? Sendersuchlauf erforderlich?

5. TITAN
→ TV-Beeinträchtigung → passenden Fehler/Hinweis wählen
→ Schritte vollständig durchführen und Ergebnisse dokumentieren

6. TYPISCHE EINORDNUNG
• Pixel/Klötzchen/Aussetzer → Signal vorhanden, aber beeinträchtigt
• 3/303 → SmartCard fehlt oder sitzt falsch
• 10/310 → keine Berechtigung/Freischaltung
• nur hohe Frequenzen/S39 betroffen → Signalweg, Verstärker, Leitung oder Dose prüfen
• nur Mediathek/App → TV-Zusatzfunktionen

7. ABSCHLUSS
Lösung oder nächsten Schritt erklären, Verständnis bestätigen lassen, vollständig dokumentieren und danach Vertrags-/Verkaufspotenzial prüfen.`},
  {key:'important-sales-after-care',title:'Vertrieb nach der Lösung – kurzer Leitfaden',tags:['Wichtig','Vertrieb','Bedarfsanalyse','Angebot','Abschluss'],aliases:['nach störung verkaufen','vertrieb im call','verkaufschance'],related:['Vertragslage prüfen','Bedarf herausfinden – nicht einfach verkaufen','Passendes Angebot formulieren','Zusammenfassen'],content:`REIHENFOLGE
Erst das Anliegen lösen oder den nächsten verbindlichen Schritt klären. Danach transparent in die Beratung wechseln.

ÜBERLEITUNG
„Ihr ursprüngliches Anliegen haben wir damit geklärt. Wenn es für Sie in Ordnung ist, schaue ich noch kurz, ob Ihr aktueller Vertrag weiterhin zu Ihrer Nutzung passt.“

BEDARF
• Wie wird Internet/TV tatsächlich genutzt?
• Wie viele Personen und Geräte?
• Streaming, Homeoffice, Gaming oder Pay-TV?
• Was stört am aktuellen Produkt?
• Was ist wichtiger: Preis, Leistung oder Komfort?

ANGEBOT
Nur passend anbieten: Bedarf → Produktmerkmal → konkreter Kundennutzen.
Beispiel: „Weil bei Ihnen mehrere Personen gleichzeitig streamen und arbeiten, wäre die höhere Bandbreite vor allem zu Stoßzeiten stabiler.“

EINWAND
Nicht dagegenreden. Erst verstehen: „Was genau hält Sie noch davon ab?“ Danach konkret auf Preis, Nutzen, Laufzeit oder Bedarf eingehen.

ABSCHLUSS
Leistung, Preis, Laufzeit und nächste Schritte vollständig erklären. Zustimmung eindeutig einholen und Bestellung nach Prozess bestätigen.

WICHTIG
Keine Störung als Druckmittel verwenden und kein Produkt versprechen, das die technische Störung angeblich automatisch löst.`}
];

(async()=>{const conn=await pool.getConnection();try{await conn.beginTransaction();const [[user]]=await conn.execute('SELECT id FROM users WHERE LOWER(username)=LOWER(?)',['tobiasprang']);if(!user)throw new Error('Konto tobiasprang nicht gefunden');let [[section]]=await conn.execute('SELECT id FROM assistant_note_sections WHERE user_id=? AND title=?',[user.id,'Verknüpft Wichtig']);if(!section){const [[m]]=await conn.execute('SELECT COALESCE(MAX(sort_order),-1)+1 n FROM assistant_note_sections WHERE user_id=?',[user.id]);const [r]=await conn.execute('INSERT INTO assistant_note_sections (user_id,external_id,title,icon,sort_order) VALUES (?,?,?,?,?)',[user.id,'linked-important','Verknüpft Wichtig','link-2',m.n]);section={id:r.insertId};}
const ids=new Map();for(let i=0;i<notes.length;i++){const n=notes[i];let [[row]]=await conn.execute('SELECT id FROM assistant_notes WHERE user_id=? AND external_id=?',[user.id,n.key]);if(!row&&n.key==='important-glossary')[[row]]=await conn.execute('SELECT id FROM assistant_notes WHERE user_id=? AND title IN (?,?)',[user.id,'Kabel-TV-Glossar – die wichtigsten Begriffe',n.title]);if(row)await conn.execute('UPDATE assistant_notes SET section_id=?,external_id=?,title=?,content=?,tags_json=?,search_aliases_json=?,sort_order=? WHERE id=?',[section.id,n.key,n.title,n.content,JSON.stringify(n.tags),JSON.stringify(n.aliases),i,row.id]);else{const [r]=await conn.execute('INSERT INTO assistant_notes (user_id,section_id,external_id,title,content,tags_json,search_aliases_json,sort_order) VALUES (?,?,?,?,?,?,?,?)',[user.id,section.id,n.key,n.title,n.content,JSON.stringify(n.tags),JSON.stringify(n.aliases),i]);row={id:r.insertId};}ids.set(n.key,row.id);}
for(const n of notes){const id=ids.get(n.key);await conn.execute('DELETE FROM assistant_note_relations WHERE user_id=? AND (note_id=? OR related_id=?)',[user.id,id,id]);const titles=[...n.related,...notes.filter(x=>x.key!==n.key).map(x=>x.title)];const marks=titles.map(()=>'?').join(',');const [targets]=await conn.execute(`SELECT id FROM assistant_notes WHERE user_id=? AND title IN (${marks})`,[user.id,...titles]);for(const target of targets){if(Number(target.id)===Number(id))continue;await conn.execute('INSERT IGNORE INTO assistant_note_relations (user_id,note_id,related_id) VALUES (?,?,?)',[user.id,id,target.id]);await conn.execute('INSERT IGNORE INTO assistant_note_relations (user_id,note_id,related_id) VALUES (?,?,?)',[user.id,target.id,id]);}}
await conn.commit();console.log(JSON.stringify({ok:true,sectionId:section.id,notes:[...ids.values()]}));}catch(e){await conn.rollback();throw e;}finally{conn.release();await pool.end();}})().catch(e=>{console.error(e.stack||e.message);process.exit(1);});
