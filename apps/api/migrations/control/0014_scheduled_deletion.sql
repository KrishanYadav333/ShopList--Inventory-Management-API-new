-- F27: deleting a business is scheduled 14 days out. Until then it is read-only and the admin (or owner) can cancel.
ALTER TABLE organizations ADD COLUMN delete_after TEXT;
ALTER TABLE organizations ADD COLUMN delete_requested_by TEXT;
