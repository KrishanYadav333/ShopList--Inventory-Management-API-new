-- Support grants gain a mode. 'view' is read-only (as before); 'assist' lets ShopList support make changes
-- inside inventory screens, and every change is counted here and recorded as "ShopList support".
ALTER TABLE support_grants ADD COLUMN mode TEXT NOT NULL DEFAULT 'view' CHECK (mode IN ('view', 'assist'));
ALTER TABLE support_grants ADD COLUMN acts INTEGER NOT NULL DEFAULT 0;
