-- Atomically claims up to p_limit 'queued' items (optionally scoped to one job) and
-- flips them to 'processing' in one statement. FOR UPDATE SKIP LOCKED means an
-- overlapping cron tick and an immediate post-create/retry "kick" can run at the same
-- time without ever claiming the same row twice -- this is the mechanism, not just a
-- comment, that makes "controlled concurrency, never one-by-one or all-at-once" safe
-- when multiple worker invocations are in flight.
CREATE OR REPLACE FUNCTION claim_bulk_dispatch_items(p_job_id uuid, p_limit int)
RETURNS SETOF bulk_dispatch_items
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE bulk_dispatch_items
  SET status = 'processing', locked_at = now(), attempted_at = now()
  WHERE id IN (
    SELECT id FROM bulk_dispatch_items
    WHERE status = 'queued' AND (p_job_id IS NULL OR job_id = p_job_id)
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION claim_bulk_dispatch_items(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_bulk_dispatch_items(uuid, int) TO service_role;
