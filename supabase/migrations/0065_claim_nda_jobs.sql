-- Atomic claim RPCs for the two new NDA job queues, same FOR UPDATE SKIP LOCKED
-- mechanism as claim_bulk_dispatch_items (migration 0037) -- an overlapping cron
-- tick and an immediate post-insert "kick" can run at the same time without ever
-- claiming the same row twice. Unlike claim_bulk_dispatch_items, these also pull rows
-- in 'retrying' whose next_retry_at has arrived, since these two tables (unlike
-- bulk_dispatch_items) retry automatically via backoff rather than only on manual
-- admin action.
CREATE OR REPLACE FUNCTION claim_pdf_generation_jobs(p_limit int)
RETURNS SETOF pdf_generation_jobs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE pdf_generation_jobs
  SET status = 'processing', locked_at = now(), started_at = coalesce(started_at, now())
  WHERE id IN (
    SELECT id FROM pdf_generation_jobs
    WHERE status = 'queued' OR (status = 'retrying' AND next_retry_at <= now())
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION claim_pdf_generation_jobs(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_pdf_generation_jobs(int) TO service_role;

CREATE OR REPLACE FUNCTION claim_document_integrity_jobs(p_limit int)
RETURNS SETOF document_integrity_jobs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE document_integrity_jobs
  SET status = 'processing', locked_at = now()
  WHERE id IN (
    SELECT id FROM document_integrity_jobs
    WHERE status = 'queued' OR (status = 'retrying' AND next_retry_at <= now())
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION claim_document_integrity_jobs(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_document_integrity_jobs(int) TO service_role;
