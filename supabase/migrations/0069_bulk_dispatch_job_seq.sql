-- Human-readable sequential numbering for bulk_dispatch_jobs ("Bulk Activity #N"),
-- surfaced in the Bulk Activity drawer and in notification-bell failure alerts.
-- The table only had a uuid id before -- fine for lookups, useless for a person to
-- refer back to ("the one I sent this morning"). GENERATED ALWAYS AS IDENTITY
-- backfills existing rows in their natural creation order (insertion order == id
-- allocation order here, since nothing else populates this table).
alter table bulk_dispatch_jobs
  add column seq bigint generated always as identity;
