ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS original_amount DECIMAL(10,2) NULL AFTER name;

-- Der bisherige offene Betrag wurde durch protokollierte Zahlungen bereits reduziert.
-- Damit rekonstruieren wir zuerst den Betrag, der ursprünglich im Formular stand.
UPDATE loans l
LEFT JOIN (
  SELECT loan_id, ROUND(SUM(amount), 2) AS paid_logged
  FROM loan_payments
  GROUP BY loan_id
) p ON p.loan_id = l.id
SET l.original_amount = ROUND(l.balance + COALESCE(p.paid_logged, 0), 2)
WHERE l.original_amount IS NULL OR l.original_amount <= 0;

-- Früher eingetragene "bereits gezahlte Raten" waren nur ein Zähler. Sie werden
-- jetzt einmalig von Insgesamt abgezogen. Bei verzinsten Krediten wird nur der
-- jeweilige Tilgungsanteil abgezogen; echte Sondertilgungen bleiben erhalten.
UPDATE loans l
LEFT JOIN (
  SELECT loan_id,
    ROUND(SUM(CASE WHEN COALESCE(note, '') LIKE 'Reguläre Rate #%' THEN 0 ELSE amount END), 2) AS special_paid
  FROM loan_payments
  GROUP BY loan_id
) p ON p.loan_id = l.id
SET l.balance = GREATEST(0, ROUND(
  CASE
    WHEN l.interest > 0 THEN
      l.original_amount * POW(1 + l.interest / 12, l.paid_months)
      - l.rate * ((POW(1 + l.interest / 12, l.paid_months) - 1) / (l.interest / 12))
    ELSE l.original_amount - l.paid_months * l.rate
  END - COALESCE(p.special_paid, 0)
, 2));
