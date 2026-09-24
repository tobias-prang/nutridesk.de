ALTER TABLE staging_transactions
  ADD COLUMN IF NOT EXISTS bank_connection_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS bank_name VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS account_iban VARCHAR(40) NULL;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS bank_connection_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS bank_name VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS account_iban VARCHAR(40) NULL;

-- Eindeutig zuordenbare Altimporte übernehmen. Bei Nutzern mit mehreren
-- Bankverbindungen wird bewusst nichts geraten.
UPDATE staging_transactions s
JOIN bank_connections b ON b.user_id=s.user_id
JOIN (SELECT user_id FROM bank_connections GROUP BY user_id HAVING COUNT(*)=1) one_bank ON one_bank.user_id=s.user_id
SET s.bank_connection_id=b.id,s.bank_name=b.bank_name,s.account_iban=b.account_iban
WHERE s.source='bank' AND s.bank_connection_id IS NULL;

UPDATE transactions t
JOIN bank_connections b ON b.user_id=t.user_id
JOIN (SELECT user_id FROM bank_connections GROUP BY user_id HAVING COUNT(*)=1) one_bank ON one_bank.user_id=t.user_id
SET t.bank_connection_id=b.id,t.bank_name=b.bank_name,t.account_iban=b.account_iban
WHERE t.tag='Bank' AND t.bank_connection_id IS NULL;
