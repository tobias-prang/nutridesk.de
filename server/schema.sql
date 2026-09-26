-- NutriDesk Datenbank-Schema (MariaDB 11.x)
-- Alle Nutzdaten hängen an users.id; Löschen eines Users räumt per CASCADE alles ab.

CREATE DATABASE IF NOT EXISTS nutridesk
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE nutridesk;

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(190) NOT NULL UNIQUE,
  pass_hash     VARCHAR(100) NOT NULL,
  name          VARCHAR(80)  NOT NULL,
  admin         TINYINT(1) NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 1:1 zu users: Körperdaten, Ziele und Design-Einstellungen
CREATE TABLE IF NOT EXISTS user_settings (
  user_id       INT UNSIGNED PRIMARY KEY,
  height_cm     DECIMAL(5,1) NULL,
  age           TINYINT UNSIGNED NULL,
  sex           ENUM('m','w') NOT NULL DEFAULT 'm',
  activity      DECIMAL(4,3) NOT NULL DEFAULT 1.375,
  ziel_typ      SMALLINT NOT NULL DEFAULT -500,
  accent        VARCHAR(12) NOT NULL DEFAULT 'lime',
  theme         ENUM('dark','light') NOT NULL DEFAULT 'dark',
  mono_digits   TINYINT(1) NOT NULL DEFAULT 1,
  compact       TINYINT(1) NOT NULL DEFAULT 0,
  onboarded     TINYINT(1) NOT NULL DEFAULT 0,
  ki_answers    TEXT NULL,
  target_weight DECIMAL(5,2) NULL,
  avatar        MEDIUMTEXT NULL,
  macro_c       TINYINT NOT NULL DEFAULT 40,
  macro_p       TINYINT NOT NULL DEFAULT 30,
  macro_f       TINYINT NOT NULL DEFAULT 30,
  water_goal_ml SMALLINT UNSIGNED NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS weights (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  `date`        DATE NOT NULL,
  kg            DECIMAL(5,2) NOT NULL,
  UNIQUE KEY uq_weight (user_id, `date`),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS water_log (
  user_id       INT UNSIGNED NOT NULL,
  `date`        DATE NOT NULL,
  glasses       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, `date`),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Gerichte (von Gemini generiert oder manuell), Zutaten als JSON-Array von Strings
CREATE TABLE IF NOT EXISTS dishes (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  name          VARCHAR(120) NOT NULL,
  kcal          SMALLINT UNSIGNED NOT NULL,
  carbs         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  protein       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  fat           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  time_min      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ingredients   JSON NOT NULL,
  source        ENUM('gemini','manual') NOT NULL DEFAULT 'manual',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_dishes_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Essensplan: pro Tag & Mahlzeit genau ein Gericht
CREATE TABLE IF NOT EXISTS meal_plan (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  `date`        DATE NOT NULL,
  meal          ENUM('fruh','mittag','abend','snack') NOT NULL,
  dish_id       INT UNSIGNED NOT NULL,
  UNIQUE KEY uq_plan (user_id, `date`, meal),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (dish_id) REFERENCES dishes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Kalorien-Tracker: was tatsächlich gegessen wurde
CREATE TABLE IF NOT EXISTS food_log (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  `date`        DATE NOT NULL,
  meal          ENUM('fruh','mittag','abend','snack') NOT NULL,
  name          VARCHAR(120) NOT NULL,
  kcal          SMALLINT UNSIGNED NOT NULL,
  carbs         SMALLINT UNSIGNED NULL,
  protein       SMALLINT UNSIGNED NULL,
  fat           SMALLINT UNSIGNED NULL,
  dish_id       INT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_food_user_date (user_id, `date`),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (dish_id) REFERENCES dishes(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS shopping_items (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  category      VARCHAR(60) NOT NULL DEFAULT 'Sonstiges',
  name          VARCHAR(120) NOT NULL,
  qty           DECIMAL(8,2) NOT NULL DEFAULT 1,
  unit          VARCHAR(20) NOT NULL DEFAULT 'Stk',
  price         DECIMAL(8,2) NOT NULL DEFAULT 0,
  checked       TINYINT(1) NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_shop_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Buchungen: amount signiert (+ Einnahme, − Ausgabe); planned=1 für angekündigte Zahlungen
CREATE TABLE IF NOT EXISTS transactions (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  `date`        DATE NOT NULL,
  name          VARCHAR(120) NOT NULL,
  category      VARCHAR(60) NOT NULL DEFAULT 'Sonstiges',
  amount        DECIMAL(10,2) NOT NULL,
  tag           VARCHAR(40) NULL,
  planned       TINYINT(1) NOT NULL DEFAULT 0,
  bank_connection_id INT UNSIGNED NULL,
  bank_name     VARCHAR(120) NULL,
  account_iban  VARCHAR(40) NULL,
  folder_id     INT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tx_user_date (user_id, `date`),
  KEY idx_tx_folder (user_id, folder_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subscriptions (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  type          ENUM('streaming','musik','mobilfunk','fitness','cloud','gaming','news','versicherung') NOT NULL DEFAULT 'streaming',
  name          VARCHAR(120) NOT NULL,
  price         DECIMAL(8,2) NOT NULL,
  `day`         TINYINT UNSIGNED NOT NULL DEFAULT 1,
  cycle         ENUM('monatlich','jährlich') NOT NULL DEFAULT 'monatlich',
  frist         VARCHAR(20) NOT NULL DEFAULT '1 Monat',
  cancel_date   DATE NULL,  -- Kündigung vorgemerkt zum / gekündigt am (NULL = aktiv)
  resume_date   DATE NULL,  -- nach Kündigung: läuft wieder ab diesem Datum
  exclude_from_totals TINYINT(1) NOT NULL DEFAULT 0, -- sichtbar, aber nicht in Finanzsummen einrechnen
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_subs_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Kredite: Tilgungssimulation rechnet der Client aus balance/rate/interest
CREATE TABLE IF NOT EXISTS loans (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  name          VARCHAR(120) NOT NULL,
  original_amount DECIMAL(10,2) NULL,
  balance       DECIMAL(10,2) NOT NULL,
  rate          DECIMAL(8,2) NOT NULL,
  interest      DECIMAL(6,4) NOT NULL DEFAULT 0,
  paid_months   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  total_installments SMALLINT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_loans_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS goals (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  icon          VARCHAR(30) NOT NULL DEFAULT 'piggy-bank',
  name          VARCHAR(120) NOT NULL,
  saved         DECIMAL(10,2) NOT NULL DEFAULT 0,
  target        DECIMAL(10,2) NOT NULL,
  rate          DECIMAL(8,2) NOT NULL,
  auto_save     TINYINT(1) NOT NULL DEFAULT 0,
  start_date    DATE NULL,
  target_date   DATE NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_goals_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Budgets: "spent" wird aus transactions des laufenden Monats je Kategorie berechnet
CREATE TABLE IF NOT EXISTS budgets (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  icon          VARCHAR(30) NOT NULL DEFAULT 'gauge',
  category      VARCHAR(60) NOT NULL,
  limit_amount  DECIMAL(8,2) NOT NULL,
  UNIQUE KEY uq_budget (user_id, category),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Vermögenswerte (Finanzen-Übersicht): Konto, Depot, Krypto, Auto, ...
CREATE TABLE IF NOT EXISTS assets (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  icon          VARCHAR(30) NOT NULL DEFAULT 'landmark',
  name          VARCHAR(120) NOT NULL,
  value         DECIMAL(12,2) NOT NULL DEFAULT 0,
  note          VARCHAR(60) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_assets_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Gerichte-Bewertungen (Daumen hoch/runter), fließen in künftige KI-Generierungen ein.
-- An den Namen gebunden, damit sie das Aufräumen alter KI-Gerichte überleben.
CREATE TABLE IF NOT EXISTS dish_ratings (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  name          VARCHAR(120) NOT NULL,
  liked         TINYINT(1) NOT NULL,  -- 1 = mag ich, 0 = nie wieder
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rating (user_id, name),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Tresor: Notizen/Tagebuch, optional pro Notiz passwortgeschützt (bcrypt-Hash)
CREATE TABLE IF NOT EXISTS notes (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  title         VARCHAR(120) NOT NULL,
  content       MEDIUMTEXT NULL,
  pass_hash     VARCHAR(100) NULL,  -- NULL = ungeschützt
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_notes_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Life-Balance: To-dos
CREATE TABLE IF NOT EXISTS todos (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  text          VARCHAR(300) NOT NULL,
  done          TINYINT(1) NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_todos_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Life-Balance: Termine (time optional als 'HH:MM')
CREATE TABLE IF NOT EXISTS appointments (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  title         VARCHAR(120) NOT NULL,
  `date`        DATE NOT NULL,
  `time`        VARCHAR(5) NULL,
  note          VARCHAR(300) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_appt_user_date (user_id, `date`),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Community: öffentlicher Chat (alle Nutzer lesen/schreiben)
CREATE TABLE IF NOT EXISTS chat_messages (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  content       VARCHAR(500) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS original_amount DECIMAL(10,2) NULL AFTER name;

-- Prüfliste für CSV- und FinTS-Importe vor der Übernahme ins Finanzbuch.
CREATE TABLE IF NOT EXISTS staging_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  `date` DATE NOT NULL,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(60) NULL,
  amount DECIMAL(12,2) NOT NULL,
  info VARCHAR(400) NULL,
  source VARCHAR(20) DEFAULT 'csv',
  dedup_key VARCHAR(120) NULL,
  bank_connection_id INT UNSIGNED NULL,
  bank_name VARCHAR(120) NULL,
  account_iban VARCHAR(40) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_staging_user (user_id),
  KEY idx_staging_dedup (user_id, dedup_key)
) ENGINE=InnoDB;

-- KI-Assistent: strukturierte Wissens- und Lernnotizen mit Bereichen und Verknüpfungen.
-- Bewusst getrennt von den passwortgeschützten Tresor-Notizen oben.
CREATE TABLE IF NOT EXISTS assistant_note_sections (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  external_id   VARCHAR(100) NULL,
  title         VARCHAR(120) NOT NULL,
  icon          VARCHAR(50) NOT NULL DEFAULT 'notebook-tabs',
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_assistant_section_external (user_id, external_id),
  KEY idx_assistant_sections_user (user_id, sort_order),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS assistant_notes (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  section_id    INT UNSIGNED NOT NULL,
  external_id   VARCHAR(120) NULL,
  title         VARCHAR(180) NOT NULL,
  content       MEDIUMTEXT NULL,
  tags_json     TEXT NULL,
  search_aliases_json TEXT NULL,
  pinned        TINYINT(1) NOT NULL DEFAULT 0,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_assistant_note_external (user_id, external_id),
  KEY idx_assistant_notes_user_section (user_id, section_id, sort_order),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (section_id) REFERENCES assistant_note_sections(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS assistant_note_relations (
  user_id       INT UNSIGNED NOT NULL,
  note_id       INT UNSIGNED NOT NULL,
  related_id    INT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, note_id, related_id),
  KEY idx_assistant_rel_related (related_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (note_id) REFERENCES assistant_notes(id) ON DELETE CASCADE,
  FOREIGN KEY (related_id) REFERENCES assistant_notes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS assistant_quick_notes (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  text          VARCHAR(500) NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_assistant_quick_user (user_id, sort_order),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Privater Couple Space: genau zwei Konten, Einmal-Einladung, gemeinsames Zeichenbrett
CREATE TABLE IF NOT EXISTS couple_spaces (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  owner_id        INT UNSIGNED NOT NULL UNIQUE,
  partner_id      INT UNSIGNED NULL UNIQUE,
  invite_hash     CHAR(64) NULL UNIQUE,
  invite_token_enc TEXT NULL,
  invite_expires  DATETIME NULL,
  started_at      DATETIME NULL,
  owner_status    VARCHAR(24) NOT NULL DEFAULT 'happy',
  partner_status  VARCHAR(24) NOT NULL DEFAULT 'happy',
  board_json      MEDIUMTEXT NULL,
  board_version   INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (partner_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;
-- user_settings hat zusätzlich: vault_pin_hash VARCHAR(100) NULL (PIN für den Tresor, bcrypt)

-- Cloud: Ordner (parent_id für Verschachtelung) und Dateien (auf Disk unter
-- /home/nutridesk.de/assets/cloud/{USER_ID}/ mit zufälligem stored_name, DB hält Metadaten).
-- users.cloud_quota BIGINT (Default 2 GB) begrenzt den Speicher pro Nutzer (Admin verwaltbar).
CREATE TABLE IF NOT EXISTS cloud_folders (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  name          VARCHAR(120) NOT NULL,
  parent_id     INT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cf_user (user_id, parent_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES cloud_folders(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS cloud_files (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  folder_id     INT UNSIGNED NULL,
  name          VARCHAR(200) NOT NULL,     -- Anzeigename
  stored_name   VARCHAR(80) NOT NULL,      -- UUID auf der Disk (nie aus Nutzereingabe)
  size          BIGINT UNSIGNED NOT NULL DEFAULT 0,
  mime          VARCHAR(120) NULL,
  category      ENUM('garantie','vertrag','rechnung','versicherung','sonstiges') NOT NULL DEFAULT 'sonstiges',
  tags          VARCHAR(300) NULL,         -- kommagetrennt
  transaction_id INT UNSIGNED NULL,        -- optional mit Finanzbuchung verknüpft
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cfil_user (user_id, folder_id),
  KEY idx_cfil_transaction (user_id, transaction_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES cloud_folders(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Ereignis-Log fürs Admin-Panel: Anmeldungen, Admin-Aktionen, KI-Läufe, Fehler
CREATE TABLE IF NOT EXISTS logs (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  level         ENUM('info','warning','error') NOT NULL DEFAULT 'info',
  user_id       INT UNSIGNED NULL,
  email         VARCHAR(190) NULL,
  event         VARCHAR(60) NOT NULL,
  message       VARCHAR(500) NULL,
  ip            VARCHAR(45) NULL,
  KEY idx_logs_created (created_at),
  KEY idx_logs_level (level),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Notgroschen (Emergency Fund) + Kredit-Sondertilgungen (2026-07-14)
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS emergency_fund DECIMAL(12,2) NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS emergency_log (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  delta         DECIMAL(12,2) NOT NULL,
  note          VARCHAR(200) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_emlog_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS loan_payments (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  loan_id       INT UNSIGNED NOT NULL,
  amount        DECIMAL(10,2) NOT NULL,
  note          VARCHAR(200) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lp_user (user_id),
  KEY idx_lp_loan (loan_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Community-Spiele: XP / Nutris / Level + rotierende Tagesquest (2026-07-14)
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS xp INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS nutris INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quest_date DATE NULL,
  ADD COLUMN IF NOT EXISTS quest_prog INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quest_claimed TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS xp_today INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS xp_today_date DATE NULL;

-- Account-Infofelder (2026-07-14)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS birthday DATE NULL,
  ADD COLUMN IF NOT EXISTS phone VARCHAR(40) NULL,
  ADD COLUMN IF NOT EXISTS street VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS zip VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS city VARCHAR(80) NULL,
  ADD COLUMN IF NOT EXISTS country VARCHAR(60) NULL;

-- Zwei-Faktor-Authentifizierung (TOTP). Das Secret wird serverseitig mit
-- AES-256-GCM verschluesselt; pending ist nur waehrend der Einrichtung gesetzt.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT NULL,
  ADD COLUMN IF NOT EXISTS totp_pending_enc TEXT NULL,
  ADD COLUMN IF NOT EXISTS totp_enabled TINYINT(1) NOT NULL DEFAULT 0;

-- Persistente FinTS-3.0-Bankparameter. Zugangsdaten bleiben separat AES-GCM-verschlüsselt;
-- banking_info enthält ausschließlich BPD/UPD, Konten und TAN-Verfahrensmetadaten.
ALTER TABLE bank_connections
  ADD COLUMN IF NOT EXISTS banking_info MEDIUMTEXT NULL,
  ADD COLUMN IF NOT EXISTS tan_method INT NULL,
  ADD COLUMN IF NOT EXISTS tan_media VARCHAR(160) NULL,
  ADD COLUMN IF NOT EXISTS client_version VARCHAR(40) NULL;

-- Herkunftskonto von importierten Finanzbuchungen als Snapshot speichern. Dadurch
-- bleibt die Zuordnung auch sichtbar, wenn eine Bankverbindung später getrennt wird.
ALTER TABLE staging_transactions
  ADD COLUMN IF NOT EXISTS bank_connection_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS bank_name VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS account_iban VARCHAR(40) NULL;
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS bank_connection_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS bank_name VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS account_iban VARCHAR(40) NULL;
ALTER TABLE cloud_files
  ADD COLUMN IF NOT EXISTS transaction_id INT UNSIGNED NULL,
  ADD INDEX IF NOT EXISTS idx_cfil_transaction (user_id, transaction_id);

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS folder_id INT UNSIGNED NULL,
  ADD INDEX IF NOT EXISTS idx_tx_folder (user_id, folder_id);

-- Mehrere Bankverbindungen pro Nutzer werden mit
-- server/scripts/migrate-bank-connections.sql migriert.

-- Bilder in strukturierten Notizen. Die Dateien liegen ausserhalb des Webroots
-- unter NOTE_IMAGE_ROOT/{user_id}; Downloads sind immer authentifiziert.
CREATE TABLE IF NOT EXISTS assistant_note_images (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED NOT NULL,
  note_id       INT UNSIGNED NOT NULL,
  name          VARCHAR(200) NOT NULL,
  alt_text      VARCHAR(500) NULL,
  caption       VARCHAR(1000) NULL,
  stored_name   VARCHAR(80) NOT NULL,
  size          BIGINT UNSIGNED NOT NULL DEFAULT 0,
  mime          VARCHAR(80) NOT NULL,
  scan_status   VARCHAR(24) NOT NULL DEFAULT 'clean',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ani_user_note (user_id, note_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (note_id) REFERENCES assistant_notes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- KI-Multi-Chat: Titel pro Session (2026-07-14)
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS title VARCHAR(120) NULL;

-- Tages-Aktivitaetsbonus (2026-07-14)
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS login_date DATE NULL;
