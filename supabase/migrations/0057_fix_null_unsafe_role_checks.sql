-- Fixes a real permission-check bug found while verifying migration 0056: several
-- SECURITY DEFINER functions guard themselves with `IF current_user_role() <> 'admin'`
-- (or `NOT IN (...)`) directly. In plpgsql, any comparison against NULL evaluates to
-- NULL, and `IF NULL THEN ... END IF` is treated as false -- so when current_user_role()
-- returns NULL (no JWT / no matching users row, e.g. an anon or malformed request), the
-- guard silently does not fire and execution falls through as if the check passed.
--
-- check_aadhaar_duplicates already avoids this via `COALESCE(current_user_role(), '')
-- NOT IN (...)`. The same COALESCE-guard pattern is applied here to the five functions
-- that were still using the unsafe direct-comparison form. No behavior changes for any
-- caller that already has a valid role -- only the NULL-role case (previously an
-- accidental bypass) now correctly raises.
create or replace function assign_proctor_id(p_proctor_id text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_proctor proctors%ROWTYPE;
  v_prefix text;
  v_max int;
  v_new_pid text;
BEGIN
  IF COALESCE(current_user_role(), '') <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can assign a Proctor ID';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;
  IF v_proctor.nda_status IS DISTINCT FROM 'NDA Signed' THEN RAISE EXCEPTION 'NDA not signed'; END IF;
  IF NOT v_proctor.vendor_verified THEN RAISE EXCEPTION 'Proctor must be verified before activation'; END IF;
  IF NULLIF(v_proctor.pid, '') IS NOT NULL THEN RAISE EXCEPTION 'Proctor already has an ID'; END IF;

  SELECT code INTO v_prefix FROM vendors WHERE name = v_proctor.vendor LIMIT 1;
  IF v_prefix IS NULL THEN
    v_prefix := upper(left(COALESCE(v_proctor.vendor, 'GEN'), 3));
  END IF;

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
$function$;

create or replace function mark_eval_ready(p_proctor_id text, p_eval_type text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_proctor proctors%ROWTYPE;
BEGIN
  IF p_eval_type NOT IN ('demo', 'assessment') THEN
    RAISE EXCEPTION 'Invalid eval_type';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  IF current_user_role() = 'vendor' THEN
    IF current_user_vendor_name() IS DISTINCT FROM v_proctor.vendor THEN
      RAISE EXCEPTION 'Not your proctor';
    END IF;
  ELSIF COALESCE(current_user_role(), '') NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  IF p_eval_type = 'demo' THEN
    UPDATE proctors SET demo_ready = 'ready', upd = now() WHERE id = p_proctor_id;
  ELSE
    UPDATE proctors SET assessment_ready = 'ready', upd = now() WHERE id = p_proctor_id;
  END IF;
END;
$function$;

create or replace function re_onboard_proctor(p_old_proctor_id text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_old proctors%ROWTYPE;
  v_new_id text;
BEGIN
  IF COALESCE(current_user_role(), '') <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can re-onboard proctors';
  END IF;

  SELECT * INTO v_old FROM proctors WHERE id = p_old_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  UPDATE proctors SET status = 'Archived', upd = now() WHERE id = p_old_proctor_id;

  v_new_id := gen_random_uuid()::text;

  INSERT INTO proctors (
    id, name, aadhaar, dob, gender, ptype, vendor, phone, email, city, state,
    notes, status, stage, by_user, at, upd
  ) VALUES (
    v_new_id, v_old.name, v_old.aadhaar, v_old.dob, v_old.gender, v_old.ptype, v_old.vendor,
    v_old.phone, v_old.email, v_old.city, v_old.state,
    'Re-onboarded from ' || COALESCE(NULLIF(v_old.pid, ''), 'previous record'),
    'In Progress', 0, auth.jwt() ->> 'email', now(), now()
  );

  RETURN v_new_id;
END;
$function$;

create or replace function submit_bgv(p_proctor_id text, p_file_url text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_proctor proctors%ROWTYPE;
BEGIN
  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  IF current_user_role() = 'vendor' THEN
    IF current_user_vendor_name() IS DISTINCT FROM v_proctor.vendor THEN
      RAISE EXCEPTION 'Not your proctor';
    END IF;
  ELSIF COALESCE(current_user_role(), '') NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  UPDATE proctors SET bgv = p_file_url, upd = now() WHERE id = p_proctor_id;
END;
$function$;

create or replace function verify_proctor(p_proctor_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_proctor proctors%ROWTYPE;
  v_docs_ok boolean;
BEGIN
  IF COALESCE(current_user_role(), '') NOT IN ('admin', 'vendor') THEN
    RAISE EXCEPTION 'Only admins and vendors can verify proctors';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  IF current_user_role() = 'vendor'
     AND v_proctor.vendor IS DISTINCT FROM current_user_vendor_name() THEN
    RAISE EXCEPTION 'You can only verify your own vendor''s proctors';
  END IF;

  v_docs_ok := NULLIF(v_proctor.doc_resume, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_passport_photo, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_grad_cert, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_aadhaar_copy, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_pan_copy, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_eye_test, '') IS NOT NULL;

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
$function$;
