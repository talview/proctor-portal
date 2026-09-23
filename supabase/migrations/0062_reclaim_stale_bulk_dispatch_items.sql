-- claim_bulk_dispatch_items (migration 0037) writes locked_at on every claim, but
-- nothing has ever read it back -- a worker crash mid-batch leaves those rows in
-- 'processing' forever, with no automatic recovery. This RPC reclaims any item whose
-- lock has gone stale: back to 'queued' for another attempt, or to 'failed' once
-- retry_count has exhausted p_max_attempts. Returns the distinct job_ids it touched so
-- the caller can recompute each affected job's progress -- otherwise a job could end up
-- with zero queued/processing items left while its own status still reads 'processing'
-- forever, since recompute_bulk_job_progress is the only thing that ever flips that.
CREATE OR REPLACE FUNCTION reclaim_stale_bulk_dispatch_items(
  p_stale_minutes int DEFAULT 5,
  p_max_attempts int DEFAULT 3
)
RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- RETURNING doesn't support DISTINCT directly on an UPDATE -- wrap it in a CTE and
  -- de-duplicate in the outer SELECT instead.
  RETURN QUERY
  WITH reclaimed AS (
    UPDATE bulk_dispatch_items
    SET status = CASE WHEN retry_count >= p_max_attempts THEN 'failed' ELSE 'queued' END,
        retry_count = retry_count + 1,
        locked_at = null,
        failure_reason = CASE WHEN retry_count >= p_max_attempts
          THEN 'Exceeded max attempts after stale-processing recovery'
          ELSE failure_reason
        END
    WHERE status = 'processing'
      AND locked_at < now() - (p_stale_minutes || ' minutes')::interval
    RETURNING job_id
  )
  SELECT DISTINCT job_id FROM reclaimed;
END;
$$;

REVOKE ALL ON FUNCTION reclaim_stale_bulk_dispatch_items(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reclaim_stale_bulk_dispatch_items(int, int) TO service_role;
