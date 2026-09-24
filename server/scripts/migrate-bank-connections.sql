-- Einmalige, verlustfreie Migration von einer auf bis zu drei Bankverbindungen.
ALTER TABLE bank_connections
  DROP PRIMARY KEY,
  ADD COLUMN id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST,
  ADD KEY idx_bank_connections_user (user_id),
  ADD UNIQUE KEY uq_bank_connections_login (user_id, blz, login);
