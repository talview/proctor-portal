-- Re-applies migration 0007 verbatim. Found by a systematic audit after discovering
-- migration 0006 had the same problem: `supabase migration repair` had marked
-- 0003-0012 as already applied to production without their SQL actually running there.
-- Direct introspection (pg_get_functiondef) showed re_onboard_proctor still had the
-- pre-0007 insert-before-archive order live. CREATE OR REPLACE makes this safe to
-- re-run regardless of current live state.
--
-- Original 0007 description, unchanged below: proctors has partial unique constraints
-- on aadhaar/email/phone scoped to `WHERE status <> 'Archived'`. re_onboard_proctor
-- inserted the new record before archiving the old one (matching the original
-- client-side ordering, chosen there to avoid orphaning data on a failed insert) --
-- but that means the still-Offboarded old row collides with the new row on every
-- re-onboard attempt. Since this whole function is already one atomic transaction,
-- there's no data-loss risk in archiving first: if the insert fails, the archive
-- rolls back too.

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

  UPDATE proctors SET status = 'Archived', upd = now() WHERE id = p_old_proctor_id;

  v_new_id := gen_random_uuid()::text;

  INSERT INTO proctors (
    id, name, aadhaar, dob, gender, ptype, managed_by, vendor, phone, email, city, state,
    notes, status, stage, by_user, at, upd
  ) VALUES (
    v_new_id, v_old.name, v_old.aadhaar, v_old.dob, v_old.gender, v_old.ptype, v_old.managed_by, v_old.vendor,
    v_old.phone, v_old.email, v_old.city, v_old.state,
    'Re-onboarded from ' || COALESCE(NULLIF(v_old.pid, ''), 'previous record'),
    'In Progress', 0, auth.jwt() ->> 'email', now(), now()
  );

  RETURN v_new_id;
END;
$$;
