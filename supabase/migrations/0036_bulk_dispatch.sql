-- Bulk Dispatch system: replaces the frontend's one-edge-function-call-per-proctor
-- loop (see InterviewSelectsPage/ProctorsPage's old runBulkAction) with a real
-- job/queue/worker architecture. Dispatch status here is intentionally a separate axis
-- from the existing business-lifecycle statuses (proctors.form_status/nda_status/
-- final_form_status) -- e.g. "Onboarding Status: Expired" + "Dispatch Status: Sent" can
-- both be true at once (the email went out fine; the signing link simply died before
-- the candidate used it). No existing status column or value is touched by this file.

CREATE TABLE bulk_dispatch_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL CHECK (job_type IN ('send_pre_onboarding_form', 'send_onboarding_docs')),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  -- Client-generated once per "click"; a double-click/refresh/retry resubmitting the
  -- same key returns the existing job instead of creating a duplicate one.
  idempotency_key text NOT NULL UNIQUE,
  created_by text NOT NULL,
  selected_count int NOT NULL,
  eligible_count int NOT NULL,
  skipped_count int NOT NULL,
  sent_count int NOT NULL DEFAULT 0,
  failed_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bulk_dispatch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES bulk_dispatch_jobs(id) ON DELETE CASCADE,
  proctor_id text NOT NULL REFERENCES proctors(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'sent', 'failed', 'skipped')),
  skip_reason text,
  failure_reason text,
  retry_count int NOT NULL DEFAULT 0,
  attempted_at timestamptz,
  sent_at timestamptz,
  -- Claim marker for the worker's SELECT ... FOR UPDATE SKIP LOCKED batch-claim query --
  -- lets an overlapping cron tick and an immediate post-create "kick" never double-work
  -- the same row.
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, proctor_id)
);

CREATE INDEX bulk_dispatch_items_queue_idx ON bulk_dispatch_items (job_id)
  WHERE status IN ('queued', 'processing');

ALTER TABLE bulk_dispatch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_dispatch_items ENABLE ROW LEVEL SECURITY;

-- Read-only for admin/coordinator -- bulk sending isn't a vendor-facing feature (vendors
-- don't add/import/send onboarding links today either). No INSERT/UPDATE/DELETE policy
-- for any role: every write goes through a service-role edge function.
CREATE POLICY bulk_dispatch_jobs_select ON bulk_dispatch_jobs FOR SELECT TO authenticated
  USING (current_user_role() IN ('admin', 'coordinator'));

CREATE POLICY bulk_dispatch_items_select ON bulk_dispatch_items FOR SELECT TO authenticated
  USING (current_user_role() IN ('admin', 'coordinator'));

-- Recomputes sent/failed counts from the item rows and CAS-flips the job to 'completed'
-- the moment nothing remains queued/processing. Called at the end of every worker
-- batch; returns whether *this* call is the one that completed it, so exactly one
-- "Bulk Send Completed" audit row gets written regardless of how many concurrent worker
-- ticks touch the same job.
CREATE OR REPLACE FUNCTION recompute_bulk_job_progress(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remaining int;
  v_just_completed boolean := false;
BEGIN
  UPDATE bulk_dispatch_jobs SET
    sent_count = (SELECT count(*) FROM bulk_dispatch_items WHERE job_id = p_job_id AND status = 'sent'),
    failed_count = (SELECT count(*) FROM bulk_dispatch_items WHERE job_id = p_job_id AND status = 'failed'),
    updated_at = now()
  WHERE id = p_job_id;

  SELECT count(*) INTO v_remaining
  FROM bulk_dispatch_items
  WHERE job_id = p_job_id AND status IN ('queued', 'processing');

  IF v_remaining = 0 THEN
    UPDATE bulk_dispatch_jobs SET status = 'completed'
    WHERE id = p_job_id AND status = 'processing';
    v_just_completed := FOUND;
  END IF;

  RETURN v_just_completed;
END;
$$;

REVOKE ALL ON FUNCTION recompute_bulk_job_progress(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recompute_bulk_job_progress(uuid) TO service_role;

-- Audit log: additive only. audit_log gets one new nullable column so a bulk-action's
-- top-level log row can carry its bulk_dispatch_jobs.id for cross-reference; the
-- existing 3-arg log_audit(...) is untouched (every current call site keeps working
-- unchanged) and a new 4-arg overload writes ref_id for the bulk functions only.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ref_id text;

CREATE OR REPLACE FUNCTION log_audit(p_action text, p_target text, p_detail text, p_ref_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_log (id, ts, usr, action, target, detail, ref_id)
  VALUES (gen_random_uuid()::text, now(), COALESCE(auth.jwt() ->> 'email', 'system'), p_action, p_target, p_detail, p_ref_id);
END;
$$;

REVOKE ALL ON FUNCTION log_audit(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_audit(text, text, text, text) TO authenticated, service_role;

-- Cron: a 1-minute drain of bulk_dispatch_items is the reliability backstop that makes
-- this architecture scale from ~100 to 500-1,000 recipients by raising batch size /
-- concurrency limits later, not by rebuilding anything -- each tick just picks up
-- whatever's still queued, regardless of how it got there or how large the backlog is.
-- The immediate EdgeRuntime.waitUntil kick (in bulk-dispatch-create/retry) gives fast
-- first progress; this is what guarantees eventual completion even for a batch too
-- large for one invocation's wall-clock ceiling.
--
-- Authentication: net.http_post is an outbound call from Postgres with no session
-- context, so it can't use a real user JWT. Deliberately NOT using the service-role key
-- here (that grants full admin power over the whole project -- too broad a credential
-- to route through Vault/pg_net just to answer "is this really our own cron job?").
-- Instead the worker function checks a narrow, purpose-built shared secret
-- (X-Bulk-Worker-Secret header) against its own BULK_WORKER_SECRET env var; the secret
-- VALUE itself is set separately via `vault.create_secret(...)`, not embedded in this
-- migration file, so nothing sensitive is committed to git -- this file only references
-- the vault secrets by name.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.schedule(
  'drain-bulk-dispatch-queue',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'bulk_dispatch_project_url') || '/functions/v1/bulk-dispatch-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Bulk-Worker-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'bulk_worker_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
  $cron$
);
