-- The daily import limit counts imported rows, not calls: a 1,500-product restore is 15 calls of 100 rows.
UPDATE plans SET limits = json_set(limits, '$.importsPerDay', 5000) WHERE id = 'free';
UPDATE plans SET limits = json_set(limits, '$.importsPerDay', 50000) WHERE id = 'standard';
