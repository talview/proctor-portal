-- Helper functions used by RLS policies, plus SECURITY DEFINER functions that replace
-- today's raw client-side .update() calls for privileged, multi-step proctor/evaluation
-- actions -- moving both the role check AND the business-rule precondition (e.g. "NDA must
-- be signed before assigning an ID") server-side, atomically, instead of a disabled button.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- Helper functions (callable by anyone; only ever return the caller's OWN role/vendor)
-- ============================================================

CREATE OR REPLACE FUNCTION current_user_role()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM users WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION current_user_vendor_name()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.name FROM users u JOIN vendors v ON v.id = u.vendor_id WHERE u.id = auth.uid();
$$;

REVOKE ALL ON FUNCTION current_user_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION current_user_vendor_name() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_user_role() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION current_user_vendor_name() TO anon, authenticated;

-- ============================================================
-- Privileged proctor lifecycle actions (admin only unless noted)
-- ============================================================

CREATE OR REPLACE FUNCTION verify_proctor(p_proctor_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proctor proctors%ROWTYPE;
  v_docs_ok boolean;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can verify proctors';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  v_docs_ok := v_proctor.doc_resume IS NOT NULL AND v_proctor.doc_passport_photo IS NOT NULL
    AND v_proctor.doc_grad_cert IS NOT NULL AND v_proctor.doc_aadhaar_copy IS NOT NULL
    AND v_proctor.doc_pan_copy IS NOT NULL AND v_proctor.doc_eye_test IS NOT NULL;

  IF NOT v_docs_ok THEN RAISE EXCEPTION 'Documents not complete'; END IF;
  IF v_proctor.nda_status IS DISTINCT FROM 'NDA Signed' THEN RAISE EXCEPTION 'NDA not signed'; END IF;
  IF v_proctor.vendor_verified THEN RAISE EXCEPTION 'Already verified'; END IF;

  UPDATE proctors SET
    vendor_verified = true,
    vendor_verified_by = auth.jwt() ->> 'email',
    vendor_verified_at = now(),
    status = 'Verified',
    stage = 2,
    upd = now()
  WHERE id = p_proctor_id;
END;
$$;

CREATE OR REPLACE FUNCTION trigger_proctor_nda(p_proctor_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proctor proctors%ROWTYPE;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can trigger NDA';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;
  IF v_proctor.demo_ready IS DISTINCT FROM 'pass' OR v_proctor.assessment_ready IS DISTINCT FROM 'pass' THEN
    RAISE EXCEPTION 'Assessment and Demo must both pass first';
  END IF;

  UPDATE proctors SET
    nda_status = 'NDA Pending',
    nda_triggered_at = now(),
    nda_triggered_by = auth.jwt() ->> 'email',
    final_form_status = 'sent',
    upd = now()
  WHERE id = p_proctor_id;
END;
$$;

CREATE OR REPLACE FUNCTION assign_proctor_id(p_proctor_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proctor proctors%ROWTYPE;
  v_prefix text;
  v_max int;
  v_new_pid text;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can assign a Proctor ID';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;
  IF v_proctor.nda_status IS DISTINCT FROM 'NDA Signed' THEN RAISE EXCEPTION 'NDA not signed'; END IF;
  IF v_proctor.pid IS NOT NULL THEN RAISE EXCEPTION 'Proctor already has an ID'; END IF;

  SELECT code INTO v_prefix FROM vendors WHERE name = COALESCE(v_proctor.managed_by, v_proctor.vendor) LIMIT 1;
  IF v_prefix IS NULL THEN
    v_prefix := upper(left(COALESCE(v_proctor.managed_by, v_proctor.vendor, 'GEN'), 3));
  END IF;

  -- serialize concurrent assignments for the same vendor prefix so two admins clicking
  -- "assign ID" at the same instant can never produce the same PID (the bug this replaces)
  PERFORM pg_advisory_xact_lock(hashtext(v_prefix));

  SELECT COALESCE(MAX((regexp_match(pid, '-(\d+)$'))[1]::int), 0)
  INTO v_max
  FROM proctors WHERE pid LIKE v_prefix || '-%';

  v_new_pid := v_prefix || '-' || lpad((v_max + 1)::text, 4, '0');

  UPDATE proctors SET
    pid = v_new_pid,
    status = 'Active',
    stage = 3,
    aat = now(),
    upd = now()
  WHERE id = p_proctor_id;

  RETURN v_new_pid;
END;
$$;

CREATE OR REPLACE FUNCTION offboard_proctor(p_proctor_id text, p_reason text, p_notes text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can offboard proctors';
  END IF;

  UPDATE proctors SET
    status = 'Offboarded',
    oat = now(),
    off_reason = p_reason,
    off_notes = p_notes,
    upd = now()
  WHERE id = p_proctor_id;
END;
$$;

CREATE OR REPLACE FUNCTION re_onboard_proctor(p_old_proctor_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old proctors%ROWTYPE;
  v_new_id text;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can re-onboard proctors';
  END IF;

  SELECT * INTO v_old FROM proctors WHERE id = p_old_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  v_new_id := gen_random_uuid()::text;

  INSERT INTO proctors (
    id, name, aadhaar, dob, gender, ptype, managed_by, vendor, phone, email, city, state,
    notes, status, stage, by_user, at, upd
  ) VALUES (
    v_new_id, v_old.name, v_old.aadhaar, v_old.dob, v_old.gender, v_old.ptype, v_old.managed_by, v_old.vendor,
    v_old.phone, v_old.email, v_old.city, v_old.state,
    'Re-onboarded from ' || COALESCE(v_old.pid, 'previous record'),
    'In Progress', 0, auth.jwt() ->> 'email', now(), now()
  );

  UPDATE proctors SET status = 'Archived', upd = now() WHERE id = p_old_proctor_id;

  RETURN v_new_id;
END;
$$;

-- ============================================================
-- Vendor/coordinator-reachable actions (own-row scoped for vendor role)
-- ============================================================

CREATE OR REPLACE FUNCTION mark_eval_ready(p_proctor_id text, p_eval_type text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proctor proctors%ROWTYPE;
BEGIN
  IF p_eval_type NOT IN ('demo', 'assessment') THEN
    RAISE EXCEPTION 'Invalid eval_type';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  IF current_user_role() = 'vendor' THEN
    IF current_user_vendor_name() IS DISTINCT FROM COALESCE(v_proctor.managed_by, v_proctor.vendor) THEN
      RAISE EXCEPTION 'Not your proctor';
    END IF;
  ELSIF current_user_role() NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  IF p_eval_type = 'demo' THEN
    UPDATE proctors SET demo_ready = 'ready', upd = now() WHERE id = p_proctor_id;
  ELSE
    UPDATE proctors SET assessment_ready = 'ready', upd = now() WHERE id = p_proctor_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION submit_bgv(p_proctor_id text, p_file_url text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proctor proctors%ROWTYPE;
BEGIN
  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  IF current_user_role() = 'vendor' THEN
    IF current_user_vendor_name() IS DISTINCT FROM COALESCE(v_proctor.managed_by, v_proctor.vendor) THEN
      RAISE EXCEPTION 'Not your proctor';
    END IF;
  ELSIF current_user_role() NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  UPDATE proctors SET bgv = p_file_url, upd = now() WHERE id = p_proctor_id;
END;
$$;

-- ============================================================
-- Evaluations (admin/coordinator; result override requires admin)
-- ============================================================

CREATE OR REPLACE FUNCTION submit_evaluation_result(p_evaluation_id uuid, p_result text, p_score numeric, p_comment text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eval proctor_evaluations%ROWTYPE;
  v_ready_field text;
  v_ready_val text;
  v_eval_val text;
  v_cert_date date;
BEGIN
  IF current_user_role() NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  SELECT * INTO v_eval FROM proctor_evaluations WHERE id = p_evaluation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evaluation not found'; END IF;

  IF v_eval.result IS NOT NULL AND current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can override an existing result';
  END IF;

  v_cert_date := CASE WHEN p_result = 'Pass' THEN CURRENT_DATE ELSE NULL END;

  UPDATE proctor_evaluations SET
    result = p_result,
    score_obtained = p_score,
    comment = p_comment,
    certified_date = v_cert_date,
    overridden_by = CASE WHEN v_eval.result IS NOT NULL THEN auth.jwt() ->> 'email' ELSE overridden_by END,
    overridden_at = CASE WHEN v_eval.result IS NOT NULL THEN now() ELSE overridden_at END
  WHERE id = p_evaluation_id;

  v_ready_field := CASE WHEN v_eval.eval_type = 'demo' THEN 'demo_ready' ELSE 'assessment_ready' END;
  v_ready_val := CASE p_result WHEN 'Pass' THEN 'pass' WHEN 'No Show' THEN 'noshow' WHEN 'Reschedule' THEN 'reschedule' ELSE 'reattempt' END;
  v_eval_val := CASE WHEN p_result = 'Pass' THEN 'Pass' ELSE 'Pending' END;

  IF v_ready_field = 'demo_ready' THEN
    UPDATE proctors SET demo_ready = v_ready_val, demo_eval = v_eval_val, upd = now() WHERE id = v_eval.proctor_id;
  ELSE
    UPDATE proctors SET assessment_ready = v_ready_val, assessment = v_eval_val, upd = now() WHERE id = v_eval.proctor_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION reschedule_evaluation(
  p_evaluation_id uuid, p_panel_user text, p_scheduled_date date, p_scheduled_time text, p_score_out_of numeric
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can reschedule evaluations';
  END IF;

  UPDATE proctor_evaluations SET
    panel_user = COALESCE(p_panel_user, panel_user),
    scheduled_date = COALESCE(p_scheduled_date, scheduled_date),
    scheduled_time = COALESCE(p_scheduled_time, scheduled_time),
    score_out_of = COALESCE(p_score_out_of, score_out_of)
  WHERE id = p_evaluation_id;
END;
$$;

-- ============================================================
-- Audit log (writes only through here -- usr comes from the session, never the client)
-- ============================================================

CREATE OR REPLACE FUNCTION log_audit(p_action text, p_target text, p_detail text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_log (id, ts, usr, action, target, detail)
  VALUES (gen_random_uuid()::text, now(), COALESCE(auth.jwt() ->> 'email', 'system'), p_action, p_target, p_detail);
END;
$$;

-- ============================================================
-- Lock down execution: authenticated only (anon has no meaningful role, would just be
-- rejected by the checks above anyway, but keep the grant surface minimal regardless)
-- ============================================================

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT unnest(ARRAY[
      'verify_proctor(text)', 'trigger_proctor_nda(text)', 'assign_proctor_id(text)',
      'offboard_proctor(text,text,text)', 're_onboard_proctor(text)',
      'mark_eval_ready(text,text)', 'submit_bgv(text,text)',
      'submit_evaluation_result(uuid,text,numeric,text)',
      'reschedule_evaluation(uuid,text,date,text,numeric)',
      'log_audit(text,text,text)'
    ]) AS sig
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
  END LOOP;
END $$;
