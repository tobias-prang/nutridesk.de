'use strict';
require('dotenv').config();
const mysql=require('mysql2/promise'),fs=require('fs'),fsp=require('fs/promises'),path=require('path'),crypto=require('crypto'),sharp=require('sharp');
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
DVB bedeutet „Digital Video Broadcasting“, also digitale Fernsehübertragung.
• DVB-C = Cable / Kabel-TV
• DVB-S = Satellite / Satellit
• DVB-T = Terrestrial / terrestrische Antenne
Der C-Tuner verarbeitet das Kabelsignal und führt den Sendersuchlauf aus.

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
Datenweg vom Kabelmodem zurück ins Netz; wichtig für Internet und Telefonie. Ein Rückwegstörer kann mehrere Anschlüsse beeinträchtigen.

DOCSIS
„Data Over Cable Service Interface Specification“. Technischer Standard für Internetdaten über das TV-Kabelnetz.

HFC
„Hybrid Fibre Coax“: Glasfaser für die weiten Strecken, Koaxialkabel auf dem letzten Weg bis ins Haus beziehungsweise zur Wohnung.

ÜP
Übergabepunkt: Übergang vom öffentlichen Vodafone-Netz in das Gebäude.

VrP
Verteilerpunkt: verteilt das Signal innerhalb des Kabelnetzes weiter.

NMC
„Network Management Centre“: Netzüberwachung und Koordination bei größeren oder bekannten Störungen.

LAN / WLAN / WAN
LAN = lokales Netzwerk per Kabel. WLAN = drahtloses lokales Netzwerk. WAN = Verbindung in ein übergeordnetes Netz beziehungsweise zum Internet.

FON / TEL
Telefonanschluss am Router. FON 1/FON 2 sind für analoge Telefone, Fax oder Anrufbeantworter. Nicht mit einem LAN-Anschluss verwechseln.

DECT
„Digital Enhanced Cordless Telecommunications“: Funkstandard für schnurlose Telefone.

Cable
Koaxialanschluss am Kabelrouter. Er wird mit dem DATA-Anschluss der Multimedia-Dose verbunden.

USB
„Universal Serial Bus“: Anschluss zum Beispiel für Speicher oder Drucker; nicht der Internetanschluss.`},
  {key:'important-network-levels',title:'Netzebenen – was behandeln wir?',tags:['Wichtig','NE3','NE4','NE5','Zuständigkeit','Techniker'],aliases:['welche netzebenen behandeln wir','netzebene zuständig','eigenverschulden'],related:['Haftung: NE3-Service & NE4-Service','Signalbeeinträchtigung NE3–NE5: Pixel, Klötzchen & Bildaussetzer','Technischer Außendienst & Servicepauschale','Übergabepunkt (ÜP) & Hausverteilung'],content:`SCHNELLANTWORT
NE3 behandeln wir. NE4 behandeln wir, wenn für das Objekt NE4-Service beziehungsweise eine entsprechende Vereinbarung besteht. Bei kundeneigenem Anschlussmaterial oder Eigenverschulden liegt der Fehler regelmäßig in NE5; dann können Kosten entstehen. TITAN und die aktuelle Objekt-/Vertragsanzeige bleiben verbindlich.

NE1 – Produktion / Sender
Inhalte entstehen beim Sender oder Programmlieferanten. Bei einem zentral fehlenden Programm kann die Ursache bereits hier liegen.

NE2 – Backbone / Kopfstelle / Transport
Transport und Aufbereitung der Signale. Größere oder bekannte Ausfälle können über Netzüberwachung beziehungsweise TITAN sichtbar sein.

NE3 – öffentliches Verteilnetz bis Übergabepunkt (ÜP)
BEHANDELN WIR. Dazu gehören Verteilerpunkte, Straßenverteilung und der Signalweg bis zum Gebäude-Übergabepunkt. Standard-Haftung: NE3-Service bis ÜP.
[ROT]NE3: WIR MÜSSEN UNS DARUM KÜMMERN. Liegt die Ursache im Vodafone-Netz, zahlt nicht der Kunde.[/ROT]

NE4 – Hausverteilnetz ab ÜP bis Anschlussdose/MMD
BEHANDELN WIR, WENN NE4-SERVICE/VEREINBARUNG VORLIEGT. Beispiele: Hausverstärker, Abzweiger, Hausleitungen und Anschlussdose. Ohne entsprechende Vereinbarung kann Eigentümer/Vermieter zuständig sein. Immer Objektstatus in TITAN prüfen.
[ROT]NE4: OBJEKT-/VERTRAGSSTATUS PRÜFEN. Mit NE4-Service kümmern wir uns; ohne Vereinbarung ist regelmäßig Eigentümer/Vermieter zuständig. Nicht vorschnell Kosten zusagen.[/ROT]

NE5 – kundeneigener Bereich ab Anschlussdose
In der Regel Kunde: Koax-/Antennenkabel, T-Stück, Verlängerung, eigener Fernseher, Receiver, Router oder sonstige Endgeräte.
[ROT]NE5 / EIGENVERSCHULDEN: Liegt die Ursache im kundeneigenen Gerät, Kabel oder Aufbau, kann der Kunde die Servicepauschale und mögliche Mehrkosten zahlen. Erst nach Prozess und Technikerfeststellung – niemals pauschal behaupten.[/ROT]

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
  {key:'important-mmd-hardware',title:'Hardware erkennen – Multimedia-Dose & Adapter',tags:['Wichtig','Hardware','MMD','DATA','TV','Radio'],aliases:['wie sieht multimedia dose aus','kabeldose','data dose','mmd adapter'],related:['Multi-Media-Dose (MMD): TV, Radio & Data','MMD: TV, Internet & Zusatzverträge im Überblick'],images:[
    {url:'https://www.vodafone.de/media/img/help-devices/hilfe-3LochDose_Kabel_weiss_schwarz-1248.jpg',name:'Wichtig-MMD-3-Loch.jpg',alt:'Originalfoto einer Vodafone 3-Loch-Multimedia-Dose',caption:'Vodafone: 3-Loch-Multimedia-Dose mit TV, Radio und DATA'},
    {url:'https://www.vodafone.de/media/img/help-devices/hilfe-4LochDose_Kabel_weiss_schwarz-1248.jpg',name:'Wichtig-MMD-4-Loch.jpg',alt:'Originalfoto einer Vodafone 4-Loch-Multimedia-Dose',caption:'Vodafone: 4-Loch-Multimedia-Dose'},
    {url:'https://www.vodafone.de/media/img/help-devices/hilfe-2-lochdose-MDD_DUO-1248x600_dt.jpg',name:'Wichtig-MMD-Adapter.jpg',alt:'Originalfoto eines Vodafone Multimedia-Dosen-Adapters',caption:'Vodafone: Adapter für eine vorhandene 2-Loch-Kabeldose'}
  ],content:`MULTIMEDIA-DOSE (MMD)
Die MMD ist die Kabel-Anschlussdose in der Wohnung. Sie kann je nach Bauart drei oder vier Anschlüsse haben.

TV
Für Fernseher oder TV-Receiver über Koaxial-/Antennenkabel.

RADIO / R
Für den klassischen Radioanschluss.

DATA
Für Kabelrouter beziehungsweise Kabelmodem. DATA wird per Koaxialkabel mit „Cable“ am Router verbunden.

2-LOCH-DOSE MIT ADAPTER
Hat die vorhandene Dose nur TV und Radio, kann je nach Anschluss ein Vodafone Multimedia-Dosen-Adapter den benötigten DATA-Anschluss bereitstellen. Nicht jede ähnlich aussehende SAT-Dose ist eine geeignete Kabeldose.

IM CALL PRÜFEN
• Wie viele Anschlüsse sieht der Kunde?
• Steht DATA, TV oder Radio an der Dose?
• Router wirklich an DATA angeschlossen?
• Fernseher wirklich am TV-Ausgang?
• Sitzen Koaxialkabel und Adapter fest?

Quelle der Originalfotos: Vodafone Hilfe – FRITZ!Box Cable 6591 / Kabelrouter-Einrichtung
https://www.vodafone.de/hilfe/router/fritzbox-cable-6591.html`},
  {key:'important-router-ports',title:'Router-Anschlüsse – FON, Cable, LAN, USB & Strom',tags:['Wichtig','Router','FON','Cable','LAN','USB','DECT'],aliases:['was ist fon','router anschlüsse','fon 1 fon 2','cable buchse'],related:['Modem-Telefonie – Leitungen, Rufnummern & Leistungsmerkmale','HomeBox-Telefonie','Multi-Media-Dose (MMD): TV, Radio & Data'],images:[
    {url:'https://www.vodafone.de/media/img/help-devices/hilfe-6591-gewindeanschluss-1248x600_dt.jpg',name:'Wichtig-Router-Cable.jpg',alt:'Originalfoto vom Kabelanschluss einer FRITZ!Box Cable',caption:'Vodafone: Koaxialkabel am Cable-Anschluss der FRITZ!Box'}
  ],content:`ROUTER
Ein Router verbindet den Kabelanschluss mit dem Heimnetz. Das integrierte Kabelmodem stellt die Internetverbindung her; der Router verteilt sie über LAN und WLAN und stellt – je nach Modell – Telefonie bereit.

CABLE
Runder Koaxialanschluss für das Kabelsignal. Verbindung: DATA an der MMD → Koaxialkabel → CABLE am Router.

FON 1 / FON 2
FON steht für Telefon. Anschluss für analoge Telefone, Faxgerät oder Anrufbeantworter. Je nach Router als TAE- oder RJ11-Buchse. Ein RJ11-Stecker sieht kleiner als ein LAN-Stecker aus.

FON S0
Bei älteren/entsprechenden FRITZ!Box-Modellen Anschluss für ISDN-Geräte oder eine ISDN-Telefonanlage.

LAN 1–4
Netzwerkanschlüsse für PC, Laptop, Spielekonsole, Switch oder andere Geräte. Ethernetkabel mit RJ45-Stecker verwenden.

WAN
Bei unterstützten Routern Anschluss zu einem externen Modem oder übergeordneten Netzwerk. Beim direkten Kabelbetrieb kommt das Kabelsignal normalerweise über CABLE, nicht WAN.

USB
Für unterstützte Speicher oder Drucker. USB stellt nicht die Kabel-Internetverbindung her.

POWER / STROM
Anschluss für das Netzteil. Nur das passende Originalnetzteil verwenden.

WLAN
Kabellose Netzwerkverbindung für Handy, Laptop und andere Geräte.

DECT
Funkverbindung für schnurlose Telefone. Das Telefon wird am Router angemeldet und nicht per LAN verbunden.

WPS
Vereinfachte WLAN-Verbindung per Tastendruck. WPS ist kein eigener Kabelanschluss.

IM CALL SCHNELL KLÄREN
• Welches Routermodell nutzt der Kunde?
• Leuchtet Power/Cable dauerhaft oder blinkt sie?
• Koaxialkabel steckt in DATA und CABLE?
• Telefon steckt in FON/TEL, nicht in LAN?
• Problem nur per WLAN? Gegenprobe per LAN.

Quellen: Vodafone Kabelrouter-Ratgeber und Vodafone Hilfe FRITZ!Box Cable 6591
https://www.vodafone.de/festnetz/kabel-router-ratgeber.html
https://www.vodafone.de/hilfe/router/fritzbox-cable-6591.html`},
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
const imageDir=path.join(process.env.STORAGE_ROOT||'/home/nutridesk.de/storage','note-images',String(user.id));await fsp.mkdir(imageDir,{recursive:true});
for(const n of notes.filter(x=>x.images&&x.images.length)){const noteId=ids.get(n.key);const [old]=await conn.execute("SELECT id,stored_name FROM assistant_note_images WHERE user_id=? AND note_id=? AND name LIKE 'Wichtig-%'",[user.id,noteId]);for(const im of old){await conn.execute('DELETE FROM assistant_note_images WHERE id=? AND user_id=?',[im.id,user.id]);await fsp.unlink(path.join(imageDir,path.basename(im.stored_name))).catch(()=>{});}for(const spec of n.images){try{const response=await fetch(spec.url,{headers:{'User-Agent':'NutriDesk Knowledge Import/1.0'}});if(!response.ok)throw new Error('HTTP '+response.status);const source=Buffer.from(await response.arrayBuffer());const out=await sharp(source).rotate().resize({width:1400,height:900,fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toBuffer();const stored=crypto.randomUUID()+'.jpg';await fsp.writeFile(path.join(imageDir,stored),out,{flag:'wx'});await conn.execute('INSERT INTO assistant_note_images (user_id,note_id,name,alt_text,caption,stored_name,size,mime,scan_status) VALUES (?,?,?,?,?,?,?,?,?)',[user.id,noteId,spec.name,spec.alt,spec.caption,stored,out.length,'image/jpeg','clean']);}catch(e){console.warn('Bild konnte nicht geladen werden:',spec.url,e.message);}}}
await conn.commit();console.log(JSON.stringify({ok:true,sectionId:section.id,notes:[...ids.values()]}));}catch(e){await conn.rollback();throw e;}finally{conn.release();await pool.end();}})().catch(e=>{console.error(e.stack||e.message);process.exit(1);});
