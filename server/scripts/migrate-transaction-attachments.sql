-- Cloud-Dateien optional mit einer Finanzbuchung verknüpfen.
-- Bestehende Dateien und Buchungen bleiben unverändert.
ALTER TABLE cloud_files
  ADD COLUMN IF NOT EXISTS transaction_id INT UNSIGNED NULL;

CREATE INDEX IF NOT EXISTS idx_cfil_transaction
  ON cloud_files (user_id, transaction_id);
