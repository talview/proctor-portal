-- Resets a job's 'failed' items back to 'queued' (incrementing retry_count) in one
-- statement -- never touches 'sent'/'skipped' items, so a retry can only ever affect
-- recipients that actually failed, matching "never resend successful recipients".
CREATE OR REPLACE FUNCTION retry_failed_bulk_dispatch_items(p_job_id uuid)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE bulk_dispatch_items
  SET status = 'queued', retry_count = retry_count + 1, failure_reason = NULL
  WHERE job_id = p_job_id AND status = 'failed';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    UPDATE bulk_dispatch_jobs SET status = 'processing', failed_count = 0, updated_at = now()
    WHERE id = p_job_id;
  END IF;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION retry_failed_bulk_dispatch_items(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retry_failed_bulk_dispatch_items(uuid) TO service_role;
