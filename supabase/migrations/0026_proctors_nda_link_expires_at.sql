-- Expiry policy is now configurable per NDA template (24h vs same_day), so
-- ProctorsPage.tsx can no longer assume a flat 24h from nda_triggered_at to render
-- the "Expired" badge (see supabase/migrations/0025 for the expiry_policy column).
-- nda-session-create sets this alongside nda_triggered_at using the same
-- session_expires_at value it computes for nda_signing_sessions, so the list view has
-- the real deadline without joining that table.

ALTER TABLE proctors ADD COLUMN IF NOT EXISTS nda_link_expires_at timestamptz;
