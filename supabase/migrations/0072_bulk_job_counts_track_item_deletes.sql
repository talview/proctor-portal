-- Migration 0070 fixed sent_count/failed_count drifting after a cascade-deleted
-- item, but left eligible_count/selected_count/skipped_count untouched -- those
-- are set once at job creation and never revisited. Confirmed live: job #4 (100
-- selected/100 eligible, 1 real item left) still showed "0 sent, 99
-- processing/queued, 1 failed" in the list view (list computes remaining as
-- eligible_count - sent_count - failed_count, so a stale eligible_count alone
-- produces phantom "processing/queued" recipients that don't exist), while the
-- detail view (which counts real item rows directly) correctly showed only the
-- 1 real item and 0 processing/queued -- the exact mismatch reported.
--
-- Fix: when an item is deleted, also shrink whichever of eligible_count/
-- skipped_count it belonged to (and selected_count, always) by 1 -- a deleted
-- item's proctor is gone, so it can never be sent to, failed, or skipped anymore;
-- it should stop being counted as pending anything. Then backfill every job's
-- three fields from the item rows that actually still exist right now.

CREATE OR REPLACE FUNCTION trg_recompute_bulk_job_on_item_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE bulk_dispatch_jobs SET
    selected_count = GREATEST(selected_count - 1, 0),
    eligible_count = CASE WHEN OLD.status = 'skipped' THEN eligible_count ELSE GREATEST(eligible_count - 1, 0) END,
    skipped_count = CASE WHEN OLD.status = 'skipped' THEN GREATEST(skipped_count - 1, 0) ELSE skipped_count END
  WHERE id = OLD.job_id;
  -- Safe even if the parent job row is itself mid-deletion in the same
  -- transaction (e.g. a cascading job delete) -- these just update 0 rows then.
  PERFORM recompute_bulk_job_progress(OLD.job_id);
  RETURN OLD;
END;
$$;

-- One-time backfill: resync every job's selected/eligible/skipped counts to the
-- item rows that actually exist right now, fixing the jobs already affected
-- before this trigger existed to prevent it (matches migration 0070's own
-- sent_count/failed_count backfill in shape).
DO $$
DECLARE
  v_job_id uuid;
BEGIN
  FOR v_job_id IN SELECT id FROM bulk_dispatch_jobs LOOP
    UPDATE bulk_dispatch_jobs j SET
      selected_count = (SELECT count(*) FROM bulk_dispatch_items WHERE job_id = j.id),
      eligible_count = (SELECT count(*) FROM bulk_dispatch_items WHERE job_id = j.id AND status != 'skipped'),
      skipped_count = (SELECT count(*) FROM bulk_dispatch_items WHERE job_id = j.id AND status = 'skipped')
    WHERE j.id = v_job_id;
    PERFORM recompute_bulk_job_progress(v_job_id);
  END LOOP;
END;
$$;
