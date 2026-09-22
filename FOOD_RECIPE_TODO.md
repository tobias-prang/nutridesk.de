# Food- und Rezept-Ausbau

## Lebensmittel

- Datenmodell um Ballaststoffe, Zucker, Salz, gesättigte Fettsäuren, Portionsgröße und Einheit erweitern.
- Allergene, Ernährungsformen und wichtige Mikronährstoffe ergänzen.
- Dubletten erkennen und Marken-/Barcode-Datensätze bereinigen.
- Nährwerte und Quellen der vorhandenen 372 Lebensmittel fachlich prüfen.
- Suche um Synonyme, Marken, Barcode und unscharfe Treffer erweitern.
- Admin-Maske für Erstellen, Bearbeiten, Zusammenführen und Deaktivieren vervollständigen.
- Für jedes freigegebene Lebensmittel ein einheitliches, lizenzsicheres Bild erzeugen, prüfen und im CDN speichern.

## Rezepte

- Alle 3.015 Rezepte auf Zutaten, Mengen, Portionen, Schritte und Nährwerte prüfen.
- Zutaten weiterhin ausschließlich über `food_id` mit der Lebensmittel-Datenbank verknüpfen.
- Portionsskalierung und automatische Nährwert-Neuberechnung fertigstellen.
- Kategorien, Mahlzeit, Zubereitungszeit, Schwierigkeitsgrad, Allergene und Ernährungsformen ergänzen.
- Unvollständige, doppelte oder fachlich unplausible Rezepte markieren und überarbeiten.
- Für jedes freigegebene Rezept ein passendes, einheitliches Bild erzeugen, prüfen und im CDN speichern.
- Bildstatus, Prompt/Quelle und CDN-Pfad nachvollziehbar in der Datenbank speichern.

## Qualität und Veröffentlichung

- Automatische Plausibilitätsprüfungen für kcal und Makronährstoffe hinzufügen.
- Stichproben und Freigabestatus für Lebensmittel und Rezepte einführen.
- Fehlende Verknüpfungen, kaputte Bilder und unvollständige Datensätze im Admin-Dashboard anzeigen.
- Bilder erst nach Prüfung öffentlich ausliefern; keine fremden urheberrechtlich geschützten Bilder übernehmen.

