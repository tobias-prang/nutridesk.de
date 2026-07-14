# NutriDesk – Projekt-Kontext & Architektur (Übergabe-Dokument)

> Diese Datei ist die **Wissensübergabe** für eine neue Claude-Sitzung (z.B. am Mac).
> Sie ersetzt den persönlichen Memory-Ordner, der maschinengebunden ist und NICHT mitwandert.
> Lies das komplett, bevor du am Projekt arbeitest. Am Ende steht, wie du dein eigenes
> Gedächtnis daraus bootstrappst.

---

## 0. Arbeitsweise mit Tobias (WICHTIG, immer beachten)

- **Sprache:** Deutsch, **du-Form**. UI-Texte/Anzeigewerte bleiben **Deutsch**.
- **Code:** durchgehend **Englisch** (Bezeichner, Dateinamen, DB-Spalten). **Keine** Kommentare im Code, außer sie erklären etwas wirklich Nicht-Offensichtliches. Frontend-Text bleibt Deutsch.
- **NIE einen Gedankenstrich** (— oder –) in Texten an Tobias verwenden. Immer Alternative (Komma, Klammer, Doppelpunkt).
- **Autonom entscheiden:** Wichtige Entscheidungen selbst nach kurzer Empfehlung treffen UND umsetzen, nicht wiederholt zur Auswahl vorlegen. Nur bei **echten externen Blockern** (fehlender Account, Hardware, Apple-Zwang etc.) stoppen und fragen.
- Tobias hat einen **eigenen VPS** (SSH-Alias `vmd197921`, teils `vmd200964`) und liefert oft **fertige HTML-Designs zur 1:1-Übernahme**.
- **Ladebalken/Skeletons** bei jedem async Laden (ihm sehr wichtig).
- Bei **scp immer absolute Pfade** verwenden (Lektion aus der Vergangenheit).

---

## 1. Was ist NutriDesk

Private **Desktop-App für Ernährung + Finanzen + Fake-KI-Assistent**, gebaut mit **Tauri 2** (früher Electron, jetzt restlos migriert). Renderer ist eine einzige große `index.html` mit einem eigenen Mini-Framework (dc-runtime). Backend ist eine **Node/Express-REST-API** auf dem VPS gegen **MariaDB**. 

**Kernprinzip „keine KI":** Es gibt **kein echtes LLM** in der App. Gemini und Claude wurden komplett entfernt.
- **Ernährungsplan** ist deterministisch aus **3015 handgeschriebenen Rezepten** (40+ Küchen).
- **Insights/Spartipps** sind regelbasiert.
- Der **„KI-Assistent" (Conrad/Anja)** ist ein **regelbasierter Bot** (`server/bot.js`), der intelligent *wirkt*: Regel-Router über eine Wissensbasis (Hilfe-Artikel), Nährwert-Lookups, eigene Nutzerdaten lesen, Aktionen mit Slot-Filling + Bestätigung, Wetter (Open-Meteo), Allgemeinwissen (wikilite). VTuber-Avatar (VRM) mit Lippensync, TTS über **ElevenLabs** (Edge-TTS wurde entfernt).

Stand der App-Version: frischer **1.0.0**-Schnitt mit der Tauri-Migration (vorher lief Electron bis ~1.0.80).

---

## 2. Verzeichnis-/Projektstruktur (lokal, dieses Repo)

```
NutriDesk/
├── CLAUDE.md              # dieses Dokument
├── package.json           # Tauri-only (dev/build/release-Scripts), Version 1.0.0
├── release.js             # baut signiert + lädt exe/Manifest auf VPS (PTB+Stable)
├── .gitignore             # schließt node_modules, target, *.key aus
├── src/
│   └── renderer/
│       ├── index.html     # DIE GANZE APP (~10k Zeilen, dc-runtime)
│       └── assets/        # dc-runtime.js, lucide.js, vtuber.js, react(-dom).js,
│                          # tauri-bridge.js (Native-Shim!), *.vrm, *.woff2, nudge.wav
├── src-tauri/
│   ├── src/lib.rs         # nativer Rust-Teil (Commands, Tray, Updater) – cfg(desktop)-Weichen
│   ├── src/main.rs        # ruft app_lib::run()
│   ├── Cargo.toml         # tauri + Plugins (updater/autostart/single-instance/notification)
│   ├── tauri.conf.json    # Config: Fenster, Bundle(nsis), plugins.updater(pubkey+endpoints)
│   ├── capabilities/      # default.json + desktop.json (Permissions)
│   ├── icons/             # App-Icons (ico/icns/png/Android/iOS)
│   ├── nutridesk.key      # PRIVATER Signaturschlüssel – NIE committen (.gitignore)
│   └── nutridesk.key.pub  # öffentlicher Schlüssel (darf ins Repo)
├── server/                # die REST-API (wird auf VPS nach /opt/nutridesk-api deployt)
│   ├── server.js          # Express-App, Auth, alle Routen
│   ├── bot.js             # Fake-KI-Assistent (require('./bot')(app,{deps}))
│   └── package.json
└── designs/               # von Tobias gelieferte HTML-Mockups (z.B. finanz-umbau.html)
```

**Server/ ist die Quelle der API**, die deployte Kopie liegt auf dem VPS unter `/opt/nutridesk-api`. Lokale Änderungen müssen dorthin deployt werden (scp + systemd restart).

---

## 3. Tauri-Architektur (Desktop + Mobil)

- **Renderer 1:1** in WebView (WebView2 auf Windows). `tauri.conf.json` → `build.frontendDist = "../src/renderer"`. `withGlobalTauri: true` (der Renderer nutzt `window.__TAURI__` direkt, kein npm-Bundling).
- **Native Brücke:** Früher gab es `window.nutridesk` (Electron-preload). Jetzt baut der Shim **`src/renderer/assets/tauri-bridge.js`** dasselbe `window.nutridesk`-Objekt nach und mappt auf `window.__TAURI__.core.invoke(...)`. Unter nicht-Tauri (Browser) ist der Shim ein No-op. Der Renderer prüft überall `if (window.nutridesk)`.
- **Rust-Commands (`src-tauri/src/lib.rs`):**
  - `app_version` → Versionsstring (alle Plattformen)
  - `notify_items` → System-Benachrichtigungen (cap 8, alle Plattformen)
  - `autostart_get`/`autostart_set` (desktop-only)
  - `upd_check`/`upd_install`/`upd_get_channel`/`upd_set_channel` (desktop-only, echter Updater)
- **Desktop-Verhalten:** Tray-Icon (Öffnen/Beenden, Linksklick zeigt Fenster), **X versteckt ins Tray** (Beenden nur übers Tray-Menü), **Single-Instance** (zweiter Start holt Fenster nach vorn), Fenstertitel **„NutriDesk · v{version}"**.
- **Mobil-fest:** Alle desktop-only Teile (Tray, Autostart, Single-Instance, Updater) sind per **`#[cfg(desktop)]`** gekapselt, mit getrennten `invoke_handler`-Listen. Auf iOS/Android bleiben nur `app_version` + `notify_items`. Damit kompiliert `tauri ios/android build` ohne Rust-Fehler.
- **CSP:** in `tauri.conf.json` bewusst noch `security.csp = null` (PoC). **TODO:** scharf setzen und mit Tobias sichtbar gegentesten.
- **API_BASE** ist im Renderer **hart** auf `https://ifasy.com/nutridesk-api` codiert (~Zeile 4872). TODO: build-target-getrieben machen.

---

## 4. Build, Signierung & Updater

### Build-Befehle
- `npm run dev` → `tauri dev`
- `npm run build` → `tauri build` (Signatur-Env muss gesetzt sein, sonst kein `.sig`)
- `npm run release` → `release.js`: baut signiert + lädt exe + Manifest in PTB + Stable hoch

### Signierung (WICHTIG)
- **minisign-Keypair** vom Tauri-Updater. Privater Key: **`src-tauri/nutridesk.key`** (ohne Passwort, per `.gitignore` ausgeschlossen, **NIE committen, gut sichern**). Public Key steht in `tauri.conf.json` unter `plugins.updater.pubkey`.
- Build braucht Env:
  - `TAURI_SIGNING_PRIVATE_KEY` = **Inhalt** der Key-Datei (String)
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = `""`
- **Key-Verlust = keine signierbaren Updates mehr.** Der Public Key ist in ausgelieferten Apps eingebacken.

### Updater-Feed
- Manifest-Format ist **`tauri.json`** (NICHT electron-updater `latest.yml`):
  ```json
  { "version":"1.0.0", "notes":"...", "pub_date":"...",
    "platforms": { "windows-x86_64": { "signature":"<.sig-Inhalt>", "url":"<exe-URL>" } } }
  ```
- **Kanäle:** stable + ptb, lokal persistiert in `%APPDATA%/de.nutridesk.app/channel.txt`.
  - Stable: `https://nutridesk.de/updates/tauri.json` – per **SEC-002 auf 503 gesperrt** bis Launch.
  - PTB (dev, **offen/live**): `https://nutridesk.de/updates/ptb/tauri.json`.
- Dateien liegen auf VPS unter `/home/nutridesk.de/web/cdn/downloads/` (stable) bzw. `.../ptb/`.
- Der Updater ist zwei-stufig: prüfen → laden (mit %-Events `upd`) → „downloaded" → Button installiert.

### Multi-Plattform-Builds (Wer baut was)
Kein einzelner Rechner baut alles. Verteilung:
| Ziel | Maschine |
|------|----------|
| Windows (.exe) | Windows-PC (fertig) ODER GitHub-Actions-Windows-Runner |
| macOS/iOS/Android | **Mac** (nativ) |
| Linux | Linux/VPS oder Docker |

**Tobias will vollständig auf den Mac.** Am Mac gehen macOS/iOS/Android nativ + Linux via Docker. **Windows** ist die Lücke:
1. **cargo-xwin** (Cross-Compile am Mac, offiziell „last resort"): `brew install nsis llvm`, `rustup target add x86_64-pc-windows-msvc`, `cargo install --locked cargo-xwin`, PATH `/opt/homebrew/opt/llvm/bin`, dann `npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc`. Haken: gelegentliche llvm-lib-Fehler, Windows-Authenticode-Signing braucht extra `osslsigncode`+Zertifikat, und die exe LÄUFT-Test geht nur unter Windows (VM). Der Updater-`.sig` (minisign) funktioniert plattformunabhängig.
2. **GitHub Actions** Windows-Runner (empfohlen, baut auf echtem Windows). 
**TODO morgen am Mac:** cargo-xwin testen; klappt es sauber → Mac-only; sonst GitHub Actions einrichten.

### GitHub-Actions-CI (fertig vorbereitet)
`.github/workflows/release.yml` existiert bereits: baut bei `git push` eines Tags `v*` **Windows + macOS + Linux gleichzeitig** (via `tauri-apps/tauri-action`) und legt ein **Draft-Release** mit allen Installern + `.sig` an. Damit ist der Windows-PC überflüssig, der Windows-Runner baut die `.exe` auf echtem Windows. **Nötige Repo-Secrets** (in GitHub unter Settings → Secrets → Actions anlegen): `TAURI_SIGNING_PRIVATE_KEY` = Inhalt von `src-tauri/nutridesk.key`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = `""` (leer). Danach: `git tag v1.0.1 && git push origin v1.0.1`. Der Updater-Feed auf nutridesk.de wird davon noch NICHT automatisch befüllt (das macht weiter `npm run release`, oder man ergänzt später einen scp-Upload-Step in der CI).

---

## 5. Infrastruktur / VPS (`vmd197921`, root-Zugang via SSH-Alias)

- **API:** `https://ifasy.com/nutridesk-api` → intern `127.0.0.1:3179`, Code in `/opt/nutridesk-api`, systemd-Service **`nutridesk-api`**. Deploy: `scp server/*.js vmd197921:/opt/nutridesk-api/` dann `systemctl restart nutridesk-api`.
- **Website + Update-Feed:** `https://nutridesk.de` → `127.0.0.1:3181`, Code in `/home/nutridesk.de/web`, läuft unter **pm2 als ROOT** (`PM2_HOME=/root/.pm2`, App-Name „nutridesk.de"). Routen `/updates/:file` (SEC-002-gated) + `/updates/ptb/:file` (offen) + `/download`.
- **Wiki-Dienst** (Allgemeinwissen für den Bot): Binary `/home/nutridesk.de/web/cdn/wiki/app`, Port `35248`, ~25GB DB.
- **DB:** MariaDB `nutridesk` auf dem VPS. **App-DB-User darf KEIN ALTER** (Schema-Änderungen nur via `sudo mysql`). MCP-`exec`-Tool hat ein **1000-Zeichen-Limit** pro Kommando, große Sachen in Häppchen.
- **DB-Zugang extern (HeidiSQL):** SSH-Tunnel zu VMD197921/VMD200964, plink braucht PPK (`heidi_rsa.ppk`), root ist dual-auth (Socket+Passwort).
- **WICHTIG:** `/home/nutridesk.de/` NIEMALS löschen. Das ist die Server-Seite (Website + Update-Feed + Wiki-DB + Cloud-Quarantäne), nicht die App.

Es gibt zwei MCP-Tools für den Server: `mcp__vmd197921__exec` und `mcp__vmd197921__sudo-exec`.

---

## 6. Backend-Details (`server/`)

- **Auth:** JWT HS256 (`JWT_SECRET`), Token mit `av` (auth_version) zur Revocation, `iss/aud/jti`. `auth()`-Middleware macht frischen `auth_version`-DB-Check. `/auth/logout-all`, `/me/password` bumpt auth_version. Account-basiertes Login-Throttling (10/15min). `requireAdmin` macht frischen `SELECT admin FROM users`.
- **CORS:** `Access-Control-Allow-Origin: *` (funktioniert für Tauri-Origin `http://tauri.localhost`; Auth per Bearer-Token, keine Cookies).
- **Bot (`server/bot.js`):** eingebunden via `require('./bot')(app, {deps})` vor dem 404-Handler, alle Helfer per Dependency-Injection. Owner-gebundene Sessions, Regel-Router, FLOW_DEFS (Slot-Filling), TTS `/bot/tts` (ElevenLabs, `message_id`+`explicit`), `/bot/tts-settings` (Opt-in `cloud_tts_enabled`).
  - **BUG-Falle:** `this.api(path,{body})` macht `JSON.stringify(body)` selbst → NIE `body: JSON.stringify(...)` übergeben.
- **Wissensbasis-Pflege (WICHTIG):** Bei JEDER Feature-Änderung die Hilfecenter-Beiträge/FAQ mitpflegen, das ist die **einzige Wissensquelle** des Bots, sonst antwortet er falsch.

---

## 7. Feature-Bereiche im Renderer

- **Ernährung:** Übersicht (reines Dashboard, keine Statistik), Lebensmittel-DB (eigene Food-DB, ~2,16 Mio OpenFoodFacts-Produkte lokal), deterministischer Ernährungsplan aus 3015 Rezepten (Ausschluss-Filter + Wochen-Einkaufsliste vorhanden).
- **Finanzen:** Umbau geplant in 5 Oberpunkte: Übersicht / Finanzbuch / Ausgaben (Abos+Kredite) / Einnahmen (Gehalt) / Sparziele. „Mon. Einkommen" → „Gehalt". Gehalt lebt in Finanzen, NICHT im Account. Design-Mockup liegt in `designs/finanz-umbau.html` (von Tobias noch zu reviewen bevor Port).
- **Community:** Discord-artiges Layout mit Kanälen (Backend: Kanäle + Profilfelder + Username-Login live). Community-Rezepte aus foods-Tabelle.
- **KI-Assistent:** eigener Tab (`area:'insights'`), VTuber-Avatar links, Chat + „Meine Tickets" rechts. Multi-Chat geplant (sichtbare Konversations-ID, mehrere Chats max 5, dauerhaftes Nutzer-Gedächtnis, Verlauf pro Chat).
- **Admin-Bereich:** in der App integriert (Screen `showAdmin`, gated via `userIsAdmin && isAdminArea`). Server-`requireAdmin` ist der eigentliche Schutz. **Geplant:** Admin-UI in eigenes Bundle auslagern (nur für Admins nachladen). Aktions-Logging mit Timing, aufklappbare Log-Details, Filter + Server-Pagination + Suche, Kundennummer pro User.
- **Settings:** Reiter Account / Erscheinungsbild / Entwickler (PTB-Kanal) / Verknüpfungen.

---

## 8. Security-Härtung (laufend)

ASVS-L2-Härtungsplan, 2-Pass-Audit. **KEINE großen Änderungen vor dem 2. Bericht.** Ticket-Reihenfolge (teils erledigt): FinTS-SSRF, TTS-Daten, Bot-Session (erledigt: owner-bound), Token-Arch (erledigt), Cloud-Upload (Quarantäne+ClamAV+magic-bytes+atomare Quota), Bank-Key, FinTS-Dedup, CSP/app://, Admin-MFA. **SEC-002:** öffentlicher Stable-Feed + Direkt-Download per 503 gesperrt (unsignierte Artefakte); da wir jetzt **signieren**, ist der SEC-002-Grund gelöst → Stable bei Launch freischalten. PTB bleibt offen.

---

## 9. Offene Aufgaben / nächste Schritte

**Migration/Build:**
- [ ] Morgen am Mac: cargo-xwin-Windows-Build testen (siehe §4) + macOS/iOS/Android nativ + Linux via Docker
- [ ] CSP scharf setzen (aktuell null)
- [ ] API_BASE build-getrieben statt hart codiert
- [ ] Ggf. GitHub-Actions-Pipeline (Repo auf GitHub, Account `nyazukix`)

**Produkt:**
- [ ] Finanz-Umbau: `designs/finanz-umbau.html` mit Tobias reviewen, dann in Renderer portieren
- [ ] Notgroschen als **2. Tab im Sparziel** (wieviel man einfach gespart hat)
- [ ] Kredit: „Einzahlung/Sondertilgung erfassen" (wie gebe ich an, dass ich getilgt habe)
- [ ] Registrierung in NutriDesk freischalten (API `REGISTRATION_OPEN=1`; Login zeigt „Konto erstellen", aber Flag war 0)
- [ ] Admin-UI in eigenes Bundle auslagern (lazy-load für Admins)
- [ ] Abo-Datum-Reset-Bug prüfen (Datum-Eingabe resettete sich; evtl. schon gefixt)
- [ ] Multi-Chat für KI-Assistent (max 5, Auto-Titel, globales Nutzer-Gedächtnis)
- [ ] Kleinigkeiten: NutriBot-„gelesen", Titel-Trennstriche, Dead-Code

**Stores (ganz am Ende):** Microsoft Store + Play (Android) + App Store (iOS/Mac). Direkt-Download für Desktop BLEIBT parallel. MSIX-Besonderheiten: Updater aus, StartupTask-Autostart, Testaccount.

---

## 10. Wie du dein Gedächtnis bootstrappst (neue Sitzung)

1. Lies dieses CLAUDE.md komplett.
2. Verifiziere den aktuellen Code-Stand (`src-tauri/src/lib.rs`, `src/renderer/index.html`, `server/server.js`, `server/bot.js`), bevor du Empfehlungen gibst, dieses Dokument kann altern.
3. Prüfe, welche der offenen Aufgaben (§9) noch offen sind, indem du Code/DB/Server anschaust, nicht raten.
4. Lege dir bei Bedarf eigene Memory-Einträge an (dein Memory-Ordner ist maschinenlokal, dieses Repo-Dokument ist die geteilte Wahrheit). Aktualisiere DIESES CLAUDE.md, wenn sich Architektur/Stand ändern, damit die Übergabe frisch bleibt.
5. Beachte immer §0 (Arbeitsweise mit Tobias).

**Letzter bekannter Stand (2026-07-14):** Electron restlos entfernt, alles auf Tauri 2, Updater live auf PTB, Code mobil-fest, Windows-Build 1.0.0 signiert und lauffähig. Nächster großer Schritt: Multi-Plattform-Builds am Mac.
