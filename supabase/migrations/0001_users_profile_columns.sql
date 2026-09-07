-- Bridge the `users` table into a Supabase Auth "profiles" table.
-- Adds a real FK to vendors (replacing free-text vendor matching for new accounts),
-- normalizes the legacy 'talview' role label, and backfills vendor_id for existing rows.
-- Does NOT touch verify_login/password yet -- that stays live until the new
-- email-based login flow is built and confirmed working (see later migration/cleanup step).

ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES vendors(id);

UPDATE users SET role = 'coordinator' WHERE role = 'talview';

UPDATE users u
SET vendor_id = v.id
FROM vendors v
WHERE u.role = 'vendor' AND u.vendor_id IS NULL AND v.name = u.vendor;
