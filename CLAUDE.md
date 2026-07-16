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
- **CSP:** in `tauri.conf.json` bewusst noch `security.csp = null` (PoC). **TODO:** scharf setzen und mit Tobias sichtbar gegentesten. **ACHTUNG beim Scharfsetzen:** das Training-Spiel lädt MediaPipe von `https://nutridesk.de/assets/mp/` – CSP muss `connect-src`/`script-src` für `https://nutridesk.de` + `blob:` + `wasm-unsafe-eval` erlauben, sonst bricht die Kamera-Übungserkennung.
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
**Zielplattformen: nur macOS, Windows, iOS, Android. KEIN Linux** (Tobias, Stand 2026-07-15). Kein einzelner Rechner baut alles. Verteilung:
| Ziel | Maschine |
|------|----------|
| Windows (.exe) | Windows-PC (fertig) ODER GitHub-Actions-Windows-Runner |
| macOS/iOS/Android | **Mac** (nativ) |

**Tobias will vollständig auf den Mac.** Am Mac gehen macOS/iOS/Android nativ. **Windows** ist die Lücke:
1. **cargo-xwin** (Cross-Compile am Mac, offiziell „last resort"): `brew install nsis llvm`, `rustup target add x86_64-pc-windows-msvc`, `cargo install --locked cargo-xwin`, PATH `/opt/homebrew/opt/llvm/bin`, dann `npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc`. Haken: gelegentliche llvm-lib-Fehler, Windows-Authenticode-Signing braucht extra `osslsigncode`+Zertifikat, und die exe LÄUFT-Test geht nur unter Windows (VM). Der Updater-`.sig` (minisign) funktioniert plattformunabhängig.
2. **GitHub Actions** Windows-Runner (empfohlen, baut auf echtem Windows). 
**TODO morgen am Mac:** cargo-xwin testen; klappt es sauber → Mac-only; sonst GitHub Actions einrichten.

### GitHub-Actions-CI (fertig vorbereitet)
`.github/workflows/release.yml` existiert bereits: baut bei `git push` eines Tags `v*` **Windows + macOS** (via `tauri-apps/tauri-action`) und legt ein **Draft-Release** mit allen Installern + `.sig` an. (Linux ist kein Zielsystem und sollte aus dem Workflow-Matrix entfernt werden, falls dort noch vorhanden.) Damit ist der Windows-PC überflüssig, der Windows-Runner baut die `.exe` auf echtem Windows. **Nötige Repo-Secrets** (in GitHub unter Settings → Secrets → Actions anlegen): `TAURI_SIGNING_PRIVATE_KEY` = Inhalt von `src-tauri/nutridesk.key`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = `""` (leer). Danach: `git tag v1.0.1 && git push origin v1.0.1`. Der Updater-Feed auf nutridesk.de wird davon noch NICHT automatisch befüllt (das macht weiter `npm run release`, oder man ergänzt später einen scp-Upload-Step in der CI).

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
- **Finanzen (Umbau FERTIG 2026-07-14):** 6-Tab-Struktur nach `designs/finanz-umbau.html`: **Übersicht / Finanzbuch / Ausgaben / Einnahmen / Sparziele / Werkzeuge** (`finTab`: overview/tx/expenses/income/goals/tools). Ausgaben hat Sub-Tabs Abos/Kredite (`expSub`). Sparziele hat Sub-Tab **Notgroschen** (`goalSub`, on-demand via `loadEmergency`, Endpunkte `/emergency`). Kredit-Karten haben **Sondertilgung-Button** (`openLoanPay` → Modal → `POST /loans/:id/payment`). Werkzeuge hat Live-Rechner (Kreditrechner + Sparplan, in `_toolVals`). Budget ist aus der Top-Nav raus, nur noch als Tool-Karte erreichbar (`showBud` existiert weiter). Alles im Browser E2E verifiziert.
- **Community:** Discord-artiges Layout mit Kanälen (Backend: Kanäle + Profilfelder + Username-Login live). Community-Rezepte aus foods-Tabelle. **Tab „Spiele"** (`commMode`): XP/Nutris-Ökonomie (getrennt, `user_settings`), rotierende Tagesquest, Spiele: **Quiz**, **Fruit Rush** (Obst fangen + Totenkopf meiden + Power-ups, Canvas), **Kalorien-Duell** (echte OFF-Produkte), **Fruit Ninja** (Wisch-Schneiden), **Training** (MediaPipe Pose-Erkennung, echt). **Ranglisten** pro Spiel (`game_scores`-Tabelle, `GET /games/leaderboard`). Punkte getunt: arcade/ninja score/5 XP. Details im Memory `community-spiele`. **CANVAS-Falle:** in Canvas-Spielen NIE setState pro Frame (ersetzt das Canvas/Video-Element) – HUD aufs Canvas zeichnen.
- **KI-Assistent:** eigener Tab (`area:'insights'`), VTuber-Avatar links, Chat + „Meine Tickets" rechts. Multi-Chat geplant (sichtbare Konversations-ID, mehrere Chats max 5, dauerhaftes Nutzer-Gedächtnis, Verlauf pro Chat).
- **Admin-Bereich:** in der App integriert (Screen `showAdmin`, gated via `userIsAdmin && isAdminArea`). Server-`requireAdmin` ist der eigentliche Schutz. **Geplant:** Admin-UI in eigenes Bundle auslagern (nur für Admins nachladen). Aktions-Logging mit Timing, aufklappbare Log-Details, Filter + Server-Pagination + Suche, Kundennummer pro User.
- **Settings:** Reiter Account / Erscheinungsbild / Entwickler (PTB-Kanal) / Verknüpfungen.

---

## 8. Security-Härtung (laufend)

ASVS-L2-Härtungsplan, 2-Pass-Audit. **KEINE großen Änderungen vor dem 2. Bericht.** Ticket-Reihenfolge (teils erledigt): FinTS-SSRF, TTS-Daten, Bot-Session (erledigt: owner-bound), Token-Arch (erledigt), Cloud-Upload (Quarantäne+ClamAV+magic-bytes+atomare Quota), Bank-Key, FinTS-Dedup, CSP/app://, Admin-MFA. **SEC-002:** öffentlicher Stable-Feed + Direkt-Download per 503 gesperrt (unsignierte Artefakte); da wir jetzt **signieren**, ist der SEC-002-Grund gelöst → Stable bei Launch freischalten. PTB bleibt offen.

---

## 9. Offene Aufgaben / nächste Schritte

**Migration/Build (das ist der Grund für den Mac, siehe §12):**
- [ ] Am Mac: macOS/iOS/Android nativ bauen + Windows-Lücke schließen (cargo-xwin ODER GitHub Actions, siehe §4/§12)
- [ ] CSP scharf setzen (aktuell `null`). **ACHTUNG:** Training-Spiel lädt MediaPipe von `https://nutridesk.de/assets/mp/` → CSP muss `connect-src`/`script-src` `https://nutridesk.de` + `blob:` + `wasm-unsafe-eval` erlauben, sonst bricht die Kamera-Übungserkennung.
- [x] Repo auf GitHub angelegt: **`tobias-prang/NutriDesk`** (privat, Default-Branch `main`), Remote `origin` per HTTPS + gh-Credential-Helper. Auth via `gh` (Account `tobias-prang`, Token-Scopes u.a. `repo`, `workflow`).
- [ ] GitHub-Actions-Pipeline scharf schalten: `.github/workflows/release.yml` liegt im Repo, es fehlen nur noch die Secrets `TAURI_SIGNING_PRIVATE_KEY` (Inhalt von `src-tauri/nutridesk.key`) und `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (leer). ACHTUNG: damit landet der private Signing-Key in den GitHub-Actions-Secrets, bewusste Entscheidung von Tobias nötig.

**Produkt (erledigt seit letztem Stand ist in §11 dokumentiert):**
- [x] Finanz-Umbau auf 6-Tab-Struktur (FERTIG, E2E verifiziert)
- [x] Notgroschen als 2. Sparziel-Tab + Kredit-Sondertilgung (FERTIG)
- [x] Account-Bereich ausgebaut, KI-Multi-Chat, NutriBot-„gelesen", Chats rechts (FERTIG)
- [x] Community-Spiele komplett inkl. Fitness/MediaPipe, Ranglisten, 5 Cover (FERTIG, §11)
- [ ] Fitness-Spiel mit echter Webcam testen (headless nicht möglich, Tobias muss)
- [ ] Cheat-Schutz Fitness (Live-Challenge + Serverplausibilität) – noch nicht gebaut, unkritisch da nur kosmetische Belohnung
- [ ] Admin-UI in eigenes Bundle auslagern (lazy-load für Admins)
- [ ] Abo-Datum-Reset-Bug prüfen (evtl. schon gefixt)
- [ ] Punkteshop wirklich kaufbar machen (aktuell nur Design)
- [ ] Bot-Wissensbasis um die neuen Spiele/Ranglisten ergänzen (Hilfe-Artikel), sonst antwortet der Bot dazu falsch (siehe §6)

**Stores (ganz am Ende):** Microsoft Store + Play (Android) + App Store (iOS/Mac). Direkt-Download für Desktop BLEIBT parallel. MSIX-Besonderheiten: Updater aus, StartupTask-Autostart, Testaccount.

---

## 10. Wie du dein Gedächtnis bootstrappst (neue Sitzung)

1. Lies dieses CLAUDE.md komplett.
2. Verifiziere den aktuellen Code-Stand (`src-tauri/src/lib.rs`, `src/renderer/index.html`, `server/server.js`, `server/bot.js`), bevor du Empfehlungen gibst, dieses Dokument kann altern.
3. Prüfe, welche der offenen Aufgaben (§9) noch offen sind, indem du Code/DB/Server anschaust, nicht raten.
4. Lege dir bei Bedarf eigene Memory-Einträge an (dein Memory-Ordner ist maschinenlokal, dieses Repo-Dokument ist die geteilte Wahrheit). Aktualisiere DIESES CLAUDE.md, wenn sich Architektur/Stand ändern, damit die Übergabe frisch bleibt.
5. Beachte immer §0 (Arbeitsweise mit Tobias).

**Renderer visuell testen (ohne Tauri-Build):** Der Renderer ist reines HTML und läuft im Browser (die API ifasy.com hat CORS `*`, `window.nutridesk` wird per `if` abgefangen). Statischen Server auf `src/renderer` starten (z.B. kleiner node-http-server) und im Browser-Pane öffnen. Login: da Registrierung offen ist, per `fetch('.../auth/register')` ein Wegwerf-Konto anlegen, den Token in `localStorage['nutridesk.token']` setzen, neu laden. Danach durch die UI klicken/prüfen (dc-runtime nutzt `<div onclick>`, nicht echte Buttons, also per JS `element.click()` ansteuern, Icons sind nach lucide `<svg>` nicht `<i>`). Wegwerf-Konto danach via sudo mysql löschen. So wurde der Finanz-Umbau verifiziert.

**Letzter bekannter Stand (2026-07-14):** Electron restlos entfernt, alles auf Tauri 2, Updater live auf PTB, Code mobil-fest, Windows-Build 1.0.0 signiert und lauffähig. Seit diesem Stand kam die komplette Community-Spiele-Ausbaustufe dazu (§11). Nächster großer Schritt: Multi-Plattform-Builds am Mac (§12).

---

## 11. Sitzungsstand 2026-07-14 (Community-Spiele, Fitness, Ranglisten) — ausführlich

Alles Folgende ist **fertig und im Browser-Pane E2E verifiziert** (Renderer über statischen Server, echte API). **Server-Änderungen sind bereits auf den VPS deployt und laufen.** Der Renderer (`src/renderer/index.html`) ist die Quelle und wird beim nächsten `npm run release` ins App-Bundle gebaut (noch KEIN neuer Build erzeugt).

### 11.1 Ökonomie & Grundgerüst (unverändert gültig)
- Community-Screen hat Tabs **„Kommunikation | Spiele"** (`commMode` talk/games). Spiele-Hub = `commIsGames`.
- **XP + Nutris getrennt:** XP = Level-Fortschritt, Nutris = Shop-Währung. In `user_settings` (Spalten: `xp, nutris, quest_date, quest_prog, quest_claimed, xp_today, xp_today_date, login_date`).
- Level-Formel: XP für Level L = `100*L*(L-1)`. Tages-XP-Cap = 500.
- Alle Frontend-Bindings der Spiele stecken in **`_gameVals(s)`** (in die Render-Objekte gespreadet).

### 11.2 Die 5 Spiele (alle im Hub als Karten mit Cover-Bild)
1. **Quiz** (`modQuiz`, Methoden `openQuiz/quizPickFinanz/quizPickFood/quizAnswer/quizNext`): Finanz/Lebensmittel, je 8 Fragen im `_QUIZ`, 5 zufällig. Reward `correct*12` XP + `correct*4` Nutris.
2. **Fruit Rush** (`modArcade`, `_arcadeInit/_arcadeStop/_arcHit/_arcadeEnd`, Canvas `#nd-arcade` 360x520): aus Tobias' „catch the demon"-Game 1:1 nachgebaut. **Obst-Emoji** (`_ARC_FRUITS`) fangen (+1), **Totenkopf 💀 nicht fangen** (-1 Leben beim Fangen), verpasstes Obst -1 Leben, **Power-ups** 🌟+5 / 💎+15 / ❤️Leben. 5 Leben, Level, 3-2-1-Countdown, Maus + Pfeiltasten. HUD (Score/Leben) wird AUFS CANVAS gezeichnet.
3. **Kalorien-Duell** (`modKcal`, game `kcal`, `openKcal/kcalPick/kcalNext`): 5 Runden aus echten OpenFoodFacts-Produkten, welches hat mehr kcal/100g. Endpunkt `GET /games/kcal-duell` (16 id-Offset-Random-Lookups → 10 diverse → 5 Paare, wegen 2,16 Mio Zeilen kein `ORDER BY RAND()`). Reward wie Quiz.
4. **Fruit Ninja** (`modNinja`, game `ninja`, `openNinja/ninjaStart/_ninjaInit/_ninjaStop/_ninjaSplat/_ninjaEnd`, Canvas `#nd-ninja` 360x520): Obst fliegt mit Gravitation hoch, per Maus/Wisch schneiden (Klingen-Trail + Saft-Partikel `_NINJA_JUICE`), **Bomben 💣 meiden**, Combo-Bonus, 3 Leben. Reward `score/5` XP + `score/12` Nutris.
5. **Training** (`modFit`, game `fitness`): siehe 11.4.

### 11.3 Ranglisten (pro Spiel)
- DB-Tabelle **`game_scores`** (PK `user_id,game`; Spalten `best, total, plays, updated_at`; Indizes auf `(game,best)` und `(game,total)`).
- `POST /games/reward` macht am Ende ein Upsert: `best=GREATEST(best, metric)`, `total=total+metric`, `plays+1`. Metric = correct (quiz/kcal) / score (arcade/ninja) / reps (fitness).
- `GET /games/leaderboard?game=…` liefert Top 10 (join `users`, Name = username→name→"Spieler") + eigenen Wert/Rang. **Metrik pro Spiel:** arcade/ninja/fitness = `best` (Highscore), quiz/kcal = `total` (Gesamt richtig).
- Frontend `modLb` / `openLb(game)` + `openLbArcade/Quiz/Kcal/Ninja`. Medaillen 🥇🥈🥉, „Rangliste"-Buttons auf Ready/Result/Over-Screens.

### 11.4 Training / Fitness (MediaPipe, ECHT umgesetzt)
- `openFitness` → Menü mit 4 Übungen (`_FITX`: Kniebeugen `squat`, Hampelmann `jack`, Knieheben `knees`, Arm-Heben `arms`) → Intro mit Datenschutzhinweis (Kamera nur lokal) → Kamera + Pose-Erkennung.
- **MediaPipe von UNSEREM CDN** `https://nutridesk.de/assets/mp/`: `vision_bundle.mjs`, `wasm/` (4 Dateien), `pose_landmarker_lite.task` (5,8 MB). Liegen physisch in `/home/nutridesk.de/web/assets/mp/`. **CORS `*`** via Middleware `app.use('/assets/mp', …)` in `web/server.js` (nötig für Cross-Origin-Import + WASM-Fetch).
- Loader **`_fitLoadMp`**: erst direktes `import()`, sonst **Blob-Import-Fallback** (Text fetchen → Blob-URL → import). Die Browser-Pane blockt Cross-Origin-Top-Level-`import()`, echtes WebView2 nicht; der Blob-Weg ist immer robust und umgeht auch strenge script-src-CSP für externe Hosts.
- **`_fitLoadMp` / `_fitBegin` / `_fitLoop` / `_fitProcess` / `_fitDraw` / `_fitHud` / `_fitStopCam` / `_fitEnd`.** Rep-Zählung: Winkel (`_fitAngle`) + Zustandsmaschine rest/effort + Hysterese + Sichtbarkeits-Gate (`_fitVis`, Landmark-visibility > 0.35). Knieheben zählt beide Beine separat. 60s-Runde, HUD (Reps/Timer/Feedback/Fortschritt) + Skelett aufs Canvas. Reward `reps*4` XP + `reps*2` Nutris.
- **Verifiziert headless:** Pipeline lädt (GPU-Delegate ~2,7s), `detectForVideo` läuft, Rep-Logik zählt korrekt (3 Sim-Kniebeugen = 3 Reps). **NICHT headless testbar:** reale Körpererkennung → Tobias muss mit Webcam testen. Kamera im Browser-Pane ist gesperrt, deshalb geht dort nur der Fehler-Screen.

### 11.5 Cover-Bilder
- 5 Cover in `src/renderer/assets/`: `game-quiz.jpg`, `game-fruitrush.jpg`, `game-fruitninja.jpg`, `game-kalorienduell.jpg`, `game-training.jpg`. Aus Tobias' Downloads-PNGs (je ~2 MB) mit **sharp** auf 560x240 JPEG verkleinert (16–34 KB). Als Karten-Header via `background:#0b0d13 url('assets/…') center/cover`.

### 11.6 WICHTIGE LEKTION: dc-runtime Canvas-Falle
**`setState` PRO FRAME ersetzt das `<canvas>`/`<video>`-Element im DOM.** Der Render-Loop zeichnet dann auf ein abgekoppeltes Canvas → Logik läuft weiter, aber UNSICHTBAR. **Regel für Canvas-Spiele:** kein `setState` pro Frame, HUD direkt aufs Canvas zeichnen, `setState` nur bei Spielende. Bei Fitness kritisch: `setState` pro Rep hätte das `<video>` neu erzeugt und die Kamera abgerissen → deshalb ist `_fitBump` ein No-op. Zusätzlich holen Arcade/Ninja-Loops das Canvas pro Frame neu (`if(cvNow!==cv){cv=cvNow;ctx=…}`).

### 11.7 Server-Deploy-Stand
- **Deployt & live** (`/opt/nutridesk-api`, Service `nutridesk-api`): `POST /games/reward` (enum `quiz/arcade/fitness/kcal/ninja`, reps-Param, getunte Punkte, game_scores-Upsert), `GET /games/leaderboard`, Fitness-Quest im `QUESTS`-Array. Deploy erfolgte per **`scp server/server.js vmd197921:/opt/nutridesk-api/`** + `systemctl restart nutridesk-api`.
- **Website deployt** (`/home/nutridesk.de/web`, pm2): CORS-Middleware für `/assets/mp` + die MediaPipe-Dateien liegen dort.
- **DB (via sudo mysql):** Tabelle `game_scores` angelegt.
- Die **lokale `server/server.js` ist die Wahrheit** und stimmt mit dem Deploy überein (per scp deployt, nicht handgepatcht).

---

## 12. Übergang auf den Mac (WICHTIG, Schritt für Schritt)

**Der Memory-Ordner (`~/.claude/projects/…/memory/`) ist maschinengebunden und wandert NICHT mit.** Diese CLAUDE.md im Projektordner ist die geteilte Wahrheit. Wenn du den Ordner `NutriDesk/` auf den Mac verschiebst, kommt alles Nötige mit — außer:

### 12.1 Was mitkommt (im Projektordner)
- Kompletter Code (`src/`, `src-tauri/`, `server/`, `designs/`), diese CLAUDE.md, die 5 Spiel-Cover, `.github/workflows/release.yml`.
- **Der Signaturschlüssel `src-tauri/nutridesk.key`** liegt im Ordner (per `.gitignore` von Git ausgeschlossen, aber physisch da) → beim Ordner-Verschieben kommt er mit. **Ohne diesen Key keine signierten Updates.** Am Mac sichern (z.B. Passwortmanager) und NIE committen. `nutridesk.key.pub` darf ins Repo.

### 12.2 Was am Mac NEU eingerichtet werden muss
1. **Claude-Client + Konnektoren neu verbinden:** v.a. den **SSH-MCP zum VPS** (`vmd197921`, teils `vmd200964`). Ohne den MCP kann die neue Sitzung NICHT deployen/DB anfassen.
2. **SSH-Config am Mac** (`~/.ssh/config`) mit Host-Alias `vmd197921` (root-Zugang) anlegen, sonst kennt weder MCP noch `scp` den Server. Analog `vmd200964`.
3. **Toolchain:** Rust/rustup, Node, Tauri-CLI, für Windows-Cross-Build `brew install nsis llvm` + `rustup target add x86_64-pc-windows-msvc` + `cargo install --locked cargo-xwin` (siehe §4). Für iOS/Android die Apple/Android-SDKs.
4. **Signatur-Env für Builds** setzen: `TAURI_SIGNING_PRIVATE_KEY` = Inhalt von `src-tauri/nutridesk.key`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = `""`.
5. **Pfade:** Alle Windows-Pfade in dieser Doku sind beispielhaft; am Mac liegt der Ordner z.B. unter `~/Projekte/NutriDesk`. Der Scratchpad (`sharp` für Bild-Resize) ist NICHT im Projekt — am Mac bei Bedarf neu `npm i sharp` in einem Temp-Ordner.

### 12.3 Erste Handlungen der neuen Mac-Sitzung
1. Diese CLAUDE.md komplett lesen (§0 Arbeitsweise beachten: Deutsch/du, kein Gedankenstrich, autonom entscheiden).
2. MCP-SSH-Verbindung testen (`ls /opt/nutridesk-api`), Code-Stand gegen §11 verifizieren (`src/renderer/index.html`, `server/server.js`).
3. Dann Build-Ziel angehen (§12.4).

### 12.4 Build-Verteilung (Ziel des Mac-Umzugs)
| Ziel | Weg |
|------|-----|
| macOS/iOS/Android | Mac nativ (`tauri build` / `tauri ios build` / `tauri android build`) |
| Windows (.exe) | cargo-xwin am Mac (last resort, llvm-Haken) ODER GitHub-Actions-Windows-Runner (empfohlen, `.github/workflows/release.yml` existiert, nur Secrets `TAURI_SIGNING_PRIVATE_KEY`/`…_PASSWORD` in GitHub anlegen, dann `git tag v1.0.x && git push`) |

### 12.5 Renderer testen ohne Build (funktioniert auch am Mac)
Renderer ist reines HTML, API `ifasy.com` hat CORS `*`. Statischen Server auf `src/renderer` starten, im Browser öffnen. Wegwerf-Konto per `fetch('https://ifasy.com/nutridesk-api/auth/register', {…, body: {email, password:"Test1234!", name:"…"}})` (Feld heißt **`name`**, nicht first/last), Token in `localStorage['nutridesk.token']` setzen, neu laden. dc-runtime: `<div onclick>` per `element.click()` ansteuern, Style-Attribute normalisiert (Leerzeichen nach `:`). **Wegwerf-Konto danach via `sudo mysql` löschen** (users + user_settings + game_scores mit der user_id). Kamera ist im Browser-Pane gesperrt → Fitness dort nur bis zum Fehler-Screen testbar.

---

## 13. Dev-Umgebung / separate Dev-App (eingerichtet 2026-07-15)

Ziel: eine **separate Dev-App** (nur macOS), um gefahrlos frei zu coden, mit **eigener Dev-DB** und Test-Accounts, komplett getrennt von der Produktion. **Diesmal dokumentiert, damit der Plan nicht wieder verloren geht.**

### 13.1 Dev-Backend auf dem VPS (`vmd197921`) — FERTIG
- **Dev-DB `nutridesk_dev`:** Kopie von `nutridesk` (gleiches Schema + Content-Tabellen: `foods` 2,16 Mio, `recipes`, `recipe_ingredients`, `banks`, `help_articles`, `help_categories`, `channels`, `app_config` behalten), alle **43 Nutzer-Tabellen geleert**. DB-User `nutridesk_dev@localhost` (volle Rechte nur auf `nutridesk_dev`, eigenes Passwort in der Dev-`.env`).
- **Dev-API `nutridesk-api-dev.service`:** Code in `/opt/nutridesk-api-dev` (Kopie von `/opt/nutridesk-api`), Port **127.0.0.1:3180**, eigene `.env` (DB_NAME=nutridesk_dev, eigenes JWT_SECRET, REGISTRATION_OPEN=1, TRELLO_TOKEN leer = Integration aus, CLOUD_ROOT=/home/nutridesk.de/web/cdn/cloud-dev). **Dev-Deploy:** `scp server/*.js vmd197921:/opt/nutridesk-api-dev/` dann `systemctl restart nutridesk-api-dev`.
- **Test-Accounts** (nur in `nutridesk_dev`): `test1`..`test5`, Passwort = Username. `test1` ist Admin+Developer, `test2`..`test5` Developer. Login per Username ODER Email (`WHERE email=? OR username=?`).
- **Tunnel Mac → Dev-API:** LaunchAgent `~/Library/LaunchAgents/de.nutridesk.devtunnel.plist` (ssh -L 127.0.0.1:3180 → VPS 3180, KeepAlive). Am Mac ist die Dev-API also unter `http://localhost:3180` erreichbar. Nichts öffentlich exponiert (kein Apache-Reverse-Proxy, bewusst so aus Sicherheitsgründen).

### 13.2 Dev-Build (macOS) — IN ARBEIT
- Separater Identifier `de.nutridesk.app.dev` (via `src-tauri/tauri.dev.conf.json`), damit die Dev-App **neben** der Produktion installierbar ist.
- Titel: `lib.rs` hängt ` · DEV` an, wenn `app.config().identifier` auf `.dev` endet → Fenstertitel `NutriDesk · v{version} · DEV`.
- API-Umschaltung + Dev-Flag über den vorhandenen Hook `window.__API_BASE` (renderer `index.html:5461`): der Dev-Build lädt früh `assets/env.js`, das `window.__API_BASE='http://localhost:3180'` und `window.__DEV__=true` setzt. `env.js` ist **gitignored** und wird pro Build erzeugt (leer bei Prod, Dev-Werte beim Dev-Build).
- Dev-Login (nur wenn `window.__DEV__`): Liste der Test-Accounts zum Anklicken, Registrieren ausgeblendet. In Prod unverändert.
- Build-Scripts: `npm run build:mac` (Prod), `npm run build:mac:dev` (Dev, schreibt Dev-`env.js` + baut mit `tauri.dev.conf.json`).

### 13.3 Admin-Modul lazy ausgelagert (2026-07-15) — FERTIG (Kern)
Der komplette Admin-Bereich ist aus `index.html` raus und in **`assets/admin.js`** als React-Komponente `window.AdminPanel` (7 Tabs: Nutzer, Board, Tickets, Logs, Konversationen, Lebensmittel, Rezepte). Der Slot in `index.html` ist `<sc-if showAdmin><x-import component-from-global-scope="AdminPanel" api toast user></x-import></sc-if>`. `admin.js` wird **nur nachgeladen wenn Admin** (`goAdmin` → `_ensureAdminModule()` injiziert das Script; Button ist per `sc-if userIsAdmin` gated). Verifiziert: Nicht-Admin (test2) → kein Button, `window.AdminPanel` bleibt undefined; Admin (test1) → lazy geladen, alle Tabs rendern. `apiFn`/`toastFn`/`adminUserObj` sind neue Render-Bindings. **Mechanik-Wissen:** `x-import` mit `from`-URL lädt EAGER (Parse-Zeit); für echtes Lazy braucht es `component-from-global-scope` OHNE `from`, dann löst dc-runtime die Komponente zur Render-Zeit via `window[name]` auf (`waitForGlobal` rendert neu, sobald definiert).

### 13.4 Toter Admin-Code entfernt (2026-07-15) — FERTIG
**66 tote Admin-Methoden + 3 Modal-Blöcke** (adminNew/adminEdit/logClear) aus `index.html` gelöscht (Brace-Counting-Skript, in 3 verifizierten Stufen, jeweils Browser-Test danach). Die alte Admin-Logik ist damit nicht mehr im Basis-Bundle. **Bewusst behalten** (weil von Nicht-Admin-Markup geteilt): `saveFood`, `delFood` (Food-Edit-Modal) und der Rezept-Wizard `saveRecipeWiz`/`rwNext`/`rwBack`/`openRecipeWizard`. Kleiner harmloser Rest: einige tote Render-Bindings (`name: this.name` → jetzt `undefined`, wird nie gerendert) und Admin-State-Initialisierer stehen noch drin (ungefährlich, nur Kosmetik). Backup vor der Löschung: `scratchpad/index_before_cleanup.html`.

### 13.5 Kosmetik-Cleanup (2026-07-15)
**57 tote `name: this.name`-Render-Bindings** der entfernten Admin-Methoden entfernt (explizite Namensliste, kein Auto-Detect, verifiziert). **Lektion dabei:** die Markup-Only-Analyse hatte übersehen, dass `loadAdminFoods`/`loadAdminRecipes`/`loadBoard` noch aus *lebendem JS* (`saveFood`/`saveRecipeWiz`/Drag-Handler) aufgerufen werden → diese 3 wurden aus dem Backup wiederhergestellt. **Bewusst NICHT weiter entfernt:** die restlichen ~30 berechneten `adm*`-Bindings + State-Felder, weil ein Teil (Food-/Rezept-/Wizard-`admFoodsView`/`admRecipesView`/`admFoodQ`/`delFood`/`openFoodAdd`/`openRecipeWizard`) noch an verbliebenem Food-/Rezept-Markup hängt. Dieses Markup wird vermutlich über `s.adminTab === 'foods'/'recipes'` gegated (was nichts mehr setzt → faktisch tot), aber das sauber zu verifizieren braucht einen fokussierten eigenen Durchgang. Bis dahin: harmlos, nur Kosmetik.
**Food-/Rezept-Reste entfernt (fokussierter Durchgang, 2026-07-15):** Der alte Admin-Food-Editor (`modFoodEdit`) und der Rezept-Wizard (`modRecipeWiz`, Schritte rwS1-rwS5) waren nach dem Tab-Ausbau **unerreichbar** (Öffner `openFoodAdd`/`openRecipeWizard` hatten null Aufrufer). Entfernt: 2 Modal-Blöcke + 30 Methoden (`saveFood`/`delFood`/`openFoodAdd`/`openRecipeWizard`/`saveRecipeWiz`/alle `rw*`/`setF*`) + ~95 Binding-/State-Einträge + die tote `_recipeWizardVals`-Methode. Behalten: `delFoodLog` (User-Tracker), `_recipeVals` (Mealplan/User-Rezepte, referenziert keinen entfernten State), Cloud `nf*`/`cf*`. Verifiziert: App + Dashboard + alle 7 Admin-Tabs + User-Ernährungsbereich (Tracker/Ernährungsplan/Meine Rezepte) laufen. Backup: `scratchpad/index_before_foodclean.html`.

**Admin-Tab-Kosmetik entfernt (2026-07-15):** Der komplette tote Admin-Tab-Render (Binding-Block 31 Z. mit adminUsers-Map/an*/ae*-Forms/admIs*/admTab*/admConv*/admTicket*/admF*/admSt*, 14 Local-Vars für Ticket+Conv-Berechnung, 36 State-/Binding-Einträge, `closeBotSession`/`exportBotSession`) ist raus. **Behalten:** `seg`/`pill` (mit Community geteilt), `adminD` (Community-Badge), `showAdmin`/`goAdmin`/`apiFn`/`adminUserObj` (live), Verifiziert: App + Dashboard + alle 7 Admin-Tabs + Community + alle Bereiche laufen, keine Fehler. Backup: `scratchpad/index_before_admtabclean.html`.

**Board-Cluster entfernt (2026-07-15):** Auch der letzte entangled Rest ist raus: die globalen Drag&Drop-Handler (`_onDragStart/_onDragEnd/_onDragOver/_onDrop`, an `document` gehängt, feuerten nach dem Markup-Ausbau ins Leere) inkl. Attach/Detach im `componentWillUnmount`, der Board-Render-Spread (IIFE mit `s.boardData`), `loadBoard`, die `setBc*`-Setter und der Board-State (`boardData`/`boardCard`/`bc*`). Verifiziert: App + alle 7 Admin-Tabs (inkl. Board-Tab in admin.js, „BOARD 0 Listen") laufen. Backup: `scratchpad/index_before_boardclean.html`.

**Damit ist die gesamte tote Admin-Logik restlos aus dem Basis-`index.html` entfernt.** Admin lebt komplett im lazy `admin.js`.
- Admin-Sub-Features in `admin.js` funktional-vereinfacht (Board ohne Drag&Drop, Rezepte ohne vollen Wizard) → bei Bedarf anreichern.
- Weitere Bereiche (Finanzen, Community, KI) noch monolithisch im `index.html`.

---

## 14. Rezept-Freigabe, Wortfilter, Einkaufsliste (2026-07-16)

### 14.1 `server/badwords.js` (NEU, gemeinsam genutzt)
Ein Wortfilter für **zwei** Aufrufer: `bot.js` maskiert damit seine Ausgaben (`badwords.mask` auf `out.reply` + Quick-Labels in `/bot/chat`), `server.js` prüft damit Rezepte (`recipeScan`).
- Stufen: `soft` (nur markieren), `hard`/`slur` (maskieren + Rezept blocken). `scan(text)` → `{hits, worst, clean}`, `mask(text)` → Wort wird zu `A********`.
- Erkennt Umlaute, **Akzente via NFD** (`épis` → `epis`), Leet (`K4CKE`) und gestauchte Wiederholungen (`Kaaacke`).
- **Zwei Matching-Wege, das ist der Kern:** Stauchen (`squeeze`) nur für **exakte** Treffer, Teilwort-Suche auf der **ungestauchten** Form. Grund: `squeeze('nigger')` = `niger`, und das steckt in **„weniger"**.
- `EXACT_ONLY` = Wörter, die nur als ganzes Wort zählen dürfen (`arsch` wegen **Barsch/Marsch**, `mongo` wegen **mongolisch**, `chink` wegen **Schinken**, `schwanz` wegen **Ochsenschwanzsuppe**, `spast` wegen `spastisch`).
- `ALLOW` = Freigaben gegen Kollisionen (`weniger`, `niger`, `deep` (= `depp` gestaucht), `pissenlit`, `monggo`, `morron`, `fagot`, `muschio`).
- **Gegen den echten Bestand getestet** (Skript im Scratchpad, jederzeit wiederholbar): 2,16 Mio `foods`-Namen → 218 Treffer (0,01%), 3015 Rezeptnamen + Hilfe-Artikel → 0, alle Strings aus `bot.js`/`server.js` → 0. **Bei jeder Wortlisten-Änderung erneut gegen `foods` prüfen**, sonst schlägt der Filter auf Lebensmittel an.

### 14.2 Rezept-Freigabe (`user_recipes`)
Community zeigt nur `is_public=1 AND status='approved'`. Neue Spalten: `status` enum(pending/approved/rejected), `reject_reason`, `reviewed_at` (**in Dev UND Prod angelegt**).
- **Anlegen setzt IMMER `status='pending'`, auch bei privat.** Sonst wäre „privat anlegen, dann öffentlich schalten" eine Umgehung der Prüfung. Der Status wird dem Nutzer nur bei `is_public` angezeigt.
- `POST /my-recipes` blockt `hard`/`slur` in Name, Zutaten und Schritten mit 400.
- Abgelehnte Rezepte: `is_public` wird auf 0 gezwungen, erneutes Teilen gibt 400.
- Admin: `GET /admin/user-recipes?view=…`, `POST /admin/user-recipes/:id/review` (Grund ist bei Ablehnung Pflicht), `POST /admin/user-recipes/checkup` (prüft alle offenen). **Präfix `/admin/user-recipes`, nicht `/admin/recipes/pending`** — sonst frisst die ältere Route `/admin/recipes/:id` das Wort „pending" als ID.
- Benachrichtigung via `botPost(uid,'recipe_ok'|'recipe_no',…)`. `bot_messages` hat `uq_bot(user_id,kind,ref)` + `INSERT IGNORE`, deshalb wird vor jedem Review die alte Zeile gelöscht, sonst käme bei einer zweiten Prüfung keine Nachricht.
- UI: Admin-Tab „Rezepte" hat Segmente **Datenbank | Freigaben** (Zähler offener Fälle). Nutzer sieht „In Prüfung" / „Abgelehnt: Grund" an der Rezeptkarte.

### 14.3 Einkaufsliste: `server/packs.js` (NEU)
`buyFor(cat, name, cookedG, pricePerKg)` macht aus der Rezeptmenge die **kaufbare** Menge. 234 der 372 Zutaten haben eine Packungsregel, 138 bleiben **lose nach Gewicht** (Fleisch, Käse, Obst, Gemüse — das kauft man so).
- **Reihenfolge im `PACKS`-Array ist die Kollisionsauflösung** und darf nicht sortiert werden: Olivenöl→Flasche vor Oliven→Glas, Essig vor Wein (sonst wird `Weißweinessig` zur Weinflasche), Gewürze vor Senf (sonst wird `Senfsamen` zum Senfglas), Öle vor Kernen (sonst wird `Sesamöl` zur Sesampackung).
- **`RAW_FACTOR`: Kochgewicht → Kaufgewicht.** Die Rezeptmengen sind bei „(gekocht)" das Gewicht **nach** dem Garen (verifiziert: `Reis (gekocht)` hat 130 kcal/100g, trocken wären ~350). Ohne Umrechnung kauft die Liste das 2,5-fache an Reis/Nudeln. Dosenbohnen sind bewusst **draußen** (Dosengewicht ist schon das Endgewicht).
- Packungsgrößen von Konzentraten zählen in **fertiger** Menge (Gemüsebrühe = Pulver für 5 l, Kartoffelpüree = 200g Pulver ergibt 1200g), sonst stehen 18 Gläser Brühe auf der Liste.
- `pantry`-Flag (Öl, Gewürze, Salz, Mehl) → „Vorrat"-Chip im Modal, erklärt die ganze Flasche auf einer Wochenliste. Preis folgt der Packung.
- `shopping_items`: neu `grams`, `pantry`, `unit` auf VARCHAR(48) (**Dev + Prod**).
- **Bekanntes Datenproblem, kein Regelfehler:** Rezepte setzen 1g Safran pro Portion an (real 0,1g) → Safran landet bei ~22 EUR/Woche.

### 14.4 Ladezustände Admin
`skRows`/`skBar` + `.nd-adm-sk`-Shimmer in `admin.js`, in **allen 7 Tabs** verdrahtet. Wichtig beim Lebensmittel-Tab (2,16 Mio Zeilen, spürbare Wartezeit).

### 14.5 Toter Code gefunden (nicht angefasst)
- `setWeek`/`setMonth` + `s.period` sind **nirgends im Markup** verdrahtet → `mult` ist immer 1. Deshalb ist die Packungs-Rundung serverseitig sicher.
- `shopWeeks` (Dashboard-Einkaufsliste) wird nirgends gerendert, die Liste läuft nur über `openShopModal`.

### 14.6 Noch offen
- **Prod-Deploy dieser Änderungen steht aus** (`badwords.js`, `packs.js`, `server.js`, `bot.js`). Die DB-Spalten sind in Prod schon da und ändern das alte Verhalten nicht (Prod hat 0 Nutzer-Rezepte). Renderer geht erst mit dem nächsten Build raus.
- Bot kennt die Spiele/Ranglisten weiterhin nicht („Wie funktioniert das Training?" → „Das weiß ich leider nicht"), siehe §9.
