-- Bug found during live testing: CertificationsPage writes a customer_name column on
-- proctor_certifications (a denormalized copy alongside the existing customer_id FK,
-- presumably for future display without a join), but no migration ever created it --
-- unlike the other issues found in today's audit, this isn't a migration that failed to
-- apply, it's a column the frontend has always expected that was never added to the
-- schema at all. Table currently has zero rows, so no backfill is needed.

ALTER TABLE proctor_certifications ADD COLUMN IF NOT EXISTS customer_name text DEFAULT '';
