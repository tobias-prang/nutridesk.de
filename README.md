# NutriDesk

NutriDesk ist eine deutschsprachige Web-App für Ernährung, Fitness, Finanzen,
Notizen, Community und persönliche Assistenz.

## Funktionen

- Lebensmittel- und Rezeptverwaltung mit Nährwerten
- Fitness- und Fortschrittstracking
- Finanzübersicht, Finanzbuch, Kredite, Abos und Sparziele
- FinTS-3.0-Anbindung mit TAN- und App-Freigabe
- Notizen mit Bildern und PDF-Export
- Community, Couple Space und Echtzeit-Zeichenfläche
- Administration, Benutzerverwaltung, TOTP-2FA und Speicherübersicht
- Cloud-Uploads mit Virenscan und Quarantäne
- ElevenLabs-Sprachausgabe mit Datenschutz-Freigabe

## Entwicklung

```bash
npm --prefix server install
cp server/.env.example server/.env
npm test
npm start
```

Die Anwendung erwartet MariaDB und die in `server/.env.example` dokumentierten
Umgebungsvariablen. Produktive Passwörter, Tokens und `.env`-Dateien gehören
nicht in das Repository.

## Betrieb

Der produktive Dienst läuft als Node.js-Anwendung hinter einem Reverse Proxy.
Dateiablagen, Quarantäne, Datenbank und Zugangsdaten liegen außerhalb des
öffentlichen Webroots. Hinweise zur lokalen SMTP-Einrichtung befinden sich in
`ops/`.

## Sicherheit

Bitte keine Zugangsdaten oder personenbezogenen Daten in Issues einstellen.
Sicherheitsprobleme sollten vertraulich an den Betreiber gemeldet werden.
