-- Stale-processing recovery for the two new NDA job queues, same principle as
-- reclaim_stale_bulk_dispatch_items (migration 0062): a 'processing' row whose
-- locked_at has gone stale means the worker that claimed it almost certainly
-- crashed or was recycled before finishing. Needs real SQL (not just the JS client's
-- filter builder) because deciding retrying-vs-failed means comparing two columns
-- per row (attempt_count >= max_attempts), which PostgREST's query filters can't
-- express directly.
--
-- Returns the rows that went terminally 'failed' (not just a count) -- the worker
-- uses this to propagate the failure into the columns a candidate/admin actually
-- sees (nda_signing_sessions.render_error, nda_session_documents.integrity_status),
-- the same propagation it already does when a job exhausts its attempts during
-- normal processing, so both code paths land in the same visible state.
CREATE OR REPLACE FUNCTION reclaim_stale_pdf_generation_jobs(p_stale_minutes int DEFAULT 5)
RETURNS SETOF pdf_generation_jobs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE pdf_generation_jobs
  SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'retrying' END,
      next_retry_at = CASE WHEN attempt_count >= max_attempts THEN null
        ELSE now() + (least(300, 30 * power(2, attempt_count)) * random()) * interval '1 second' END,
      locked_at = null,
      last_error = coalesce(last_error, 'Worker did not finish -- recovered from a stale lock')
  WHERE status = 'processing'
    AND locked_at < now() - (p_stale_minutes || ' minutes')::interval
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION reclaim_stale_pdf_generation_jobs(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reclaim_stale_pdf_generation_jobs(int) TO service_role;

CREATE OR REPLACE FUNCTION reclaim_stale_document_integrity_jobs(p_stale_minutes int DEFAULT 5)
RETURNS SETOF document_integrity_jobs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE document_integrity_jobs
  SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'retrying' END,
      next_retry_at = CASE WHEN attempt_count >= max_attempts THEN null
        ELSE now() + (least(300, 30 * power(2, attempt_count)) * random()) * interval '1 second' END,
      locked_at = null,
      last_error = coalesce(last_error, 'Worker did not finish -- recovered from a stale lock')
  WHERE status = 'processing'
    AND locked_at < now() - (p_stale_minutes || ' minutes')::interval
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION reclaim_stale_document_integrity_jobs(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reclaim_stale_document_integrity_jobs(int) TO service_role;
