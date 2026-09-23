-- bulk_dispatch_items.proctor_id cascades on proctor delete (migration 0049), but
-- nothing ever re-synced the parent job's cached sent_count/failed_count afterward
-- -- recompute_bulk_job_progress is only ever called from the worker/reclaim paths,
-- never in response to a deletion. Confirmed live: several bulk_dispatch_jobs rows
-- (created during this project's own bulk-dispatch verification work, whose
-- disposable test proctors were deleted afterward per this session's established
-- cleanup discipline) show sent/failed counts far higher than the item rows that
-- actually remain -- e.g. one job claims "60 sent, 40 failed" with exactly 1 real
-- item left, because 99 of its items were cascade-deleted along with their
-- proctors and the job's cached totals were simply never told.
--
-- Fix has two parts: a trigger so this can't silently drift again, and a one-time
-- backfill so the jobs already affected show correct numbers immediately.

CREATE OR REPLACE FUNCTION trg_recompute_bulk_job_on_item_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Safe even if the parent job row is itself mid-deletion in the same
  -- transaction (e.g. a cascading job delete) -- this just updates 0 rows then.
  PERFORM recompute_bulk_job_progress(OLD.job_id);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS bulk_dispatch_items_recompute_on_delete ON bulk_dispatch_items;
CREATE TRIGGER bulk_dispatch_items_recompute_on_delete
AFTER DELETE ON bulk_dispatch_items
FOR EACH ROW
EXECUTE FUNCTION trg_recompute_bulk_job_on_item_delete();

-- One-time backfill: resync every job's cached counts from the item rows that
-- actually exist right now, fixing any job whose numbers had already drifted
-- before this trigger existed to prevent it.
DO $$
DECLARE
  v_job_id uuid;
BEGIN
  FOR v_job_id IN SELECT id FROM bulk_dispatch_jobs LOOP
    PERFORM recompute_bulk_job_progress(v_job_id);
  END LOOP;
END;
$$;
