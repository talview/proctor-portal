-- Durable job queues replacing the NDA-signing flow's non-durable
-- EdgeRuntime.waitUntil() background work (PDF rendering at sign time, the
-- certificate/audit-page pass at finalize time, per-document integrity
-- verification). If the function instance recycles before that promise
-- resolves, the work is silently abandoned -- these tables make the work
-- resumable/retryable instead, mirroring the bulk_dispatch_jobs/items pattern
-- already proven in production (FOR UPDATE SKIP LOCKED claim, bounded-
-- concurrency worker, self-disabling cron backstop).

CREATE TABLE pdf_generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES nda_signing_sessions(id) ON DELETE CASCADE,
  job_type text NOT NULL CHECK (job_type IN ('sign_render', 'finalize_certificate')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'retrying', 'completed', 'failed')),
  -- sign_render only -- the signature image and any free-text field values the
  -- candidate entered, persisted so the worker can render later without needing
  -- the original request's in-memory data.
  signature_storage_path text,
  text_values jsonb NOT NULL DEFAULT '{}',
  attempt_count int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  last_error text,
  next_retry_at timestamptz,
  locked_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotent: a retried sign click or a double-clicked Submit hits the same row
  -- instead of creating a duplicate PDF job.
  UNIQUE (session_id, job_type)
);
CREATE INDEX pdf_generation_jobs_open_idx ON pdf_generation_jobs (status) WHERE status IN ('queued', 'processing', 'retrying');

CREATE TABLE document_integrity_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES nda_signing_sessions(id) ON DELETE CASCADE,
  doc_kind text NOT NULL,
  storage_path text NOT NULL,
  client_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'retrying', 'completed', 'failed')),
  attempt_count int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  last_error text,
  next_retry_at timestamptz,
  locked_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One row per document per session -- re-uploading (replacing) a document
  -- upserts this row rather than creating a second one.
  UNIQUE (session_id, doc_kind)
);
CREATE INDEX document_integrity_jobs_open_idx ON document_integrity_jobs (status) WHERE status IN ('queued', 'processing', 'retrying');

ALTER TABLE pdf_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_integrity_jobs ENABLE ROW LEVEL SECURITY;

-- Read-only for admin/coordinator, exact mirror of bulk_dispatch_jobs/items'
-- policy (migration 0036) -- every write goes through the service-role worker,
-- never through the authenticated app. The candidate never queries these
-- tables directly either way: nda-session-status runs under the service-role
-- client and only ever hands back the specific derived fields it chooses to.
CREATE POLICY pdf_generation_jobs_select ON pdf_generation_jobs FOR SELECT TO authenticated
  USING (current_user_role() IN ('admin', 'coordinator'));

CREATE POLICY document_integrity_jobs_select ON document_integrity_jobs FOR SELECT TO authenticated
  USING (current_user_role() IN ('admin', 'coordinator'));

-- Self-disabling cron for the new worker, mirroring ensure_bulk_dispatch_cron()
-- (migration 0051) with one deliberate difference: unlike bulk_dispatch_items
-- (no automatic future retry -- a failed item just sits until an admin manually
-- retries it), these two tables DO retry automatically via next_retry_at. A
-- single "does open work exist" check can't safely double as both "stay armed"
-- and "invoke the worker now" here -- a job legitimately waiting minutes for its
-- next_retry_at would cause the cron to disarm itself, and nothing would ever
-- re-arm it when that retry becomes due (ensure_nda_jobs_cron is only called
-- from job-insertion points, not from a "retry became due" event). So this
-- splits the two questions: stay armed while ANY row is in a non-terminal state
-- regardless of timing; only actually invoke the worker when something is
-- genuinely actionable right now (queued, a due retry, or a processing row
-- whose lock has gone stale -- a fresh processing row may still have a live
-- worker on it, so it doesn't need a redundant kick).
CREATE OR REPLACE FUNCTION ensure_nda_jobs_cron()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public' AS $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'drain-nda-jobs-queue';
  PERFORM cron.schedule(
    'drain-nda-jobs-queue',
    '* * * * *',
    $cron$
    do $body$
    declare
      v_has_open_work boolean;
      v_should_invoke boolean;
    begin
      select exists(
        select 1 from pdf_generation_jobs where status in ('queued','processing','retrying')
        union all
        select 1 from document_integrity_jobs where status in ('queued','processing','retrying')
      ) into v_has_open_work;

      if v_has_open_work then
        select exists(
          select 1 from pdf_generation_jobs
            where status = 'queued'
               or (status = 'processing' and locked_at < now() - interval '5 minutes')
               or (status = 'retrying' and next_retry_at <= now())
          union all
          select 1 from document_integrity_jobs
            where status = 'queued'
               or (status = 'processing' and locked_at < now() - interval '5 minutes')
               or (status = 'retrying' and next_retry_at <= now())
        ) into v_should_invoke;

        if v_should_invoke then
          perform net.http_post(
            url := (select decrypted_secret from vault.decrypted_secrets where name = 'bulk_dispatch_project_url') || '/functions/v1/nda-jobs-worker',
            headers := jsonb_build_object(
              'Content-Type', 'application/json',
              'X-Nda-Worker-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'nda_worker_secret')
            ),
            body := '{}'::jsonb,
            timeout_milliseconds := 8000
          );
        end if;
      else
        perform cron.unschedule(jobid) from cron.job where jobname = 'drain-nda-jobs-queue';
      end if;
    end;
    $body$;
    $cron$
  );
END;
$$;

REVOKE ALL ON FUNCTION ensure_nda_jobs_cron() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_nda_jobs_cron() TO service_role;
