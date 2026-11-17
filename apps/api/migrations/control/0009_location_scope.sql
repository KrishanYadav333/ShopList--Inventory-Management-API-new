-- Staff can be limited to some locations for writes. NULL means all locations.
ALTER TABLE memberships ADD COLUMN location_ids TEXT;
ALTER TABLE invitations ADD COLUMN location_ids TEXT;
