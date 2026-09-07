-- Bug found during live testing: proctors.pid is often an empty string '' rather than
-- NULL for records that haven't been assigned an ID yet (matching the original app's
-- JS truthiness checks like `if (proctor.pid)`), but assign_proctor_id's guard used
-- `IS NOT NULL`, which treats '' as "already has an ID" and incorrectly blocks every
-- assignment. Fix: treat empty string the same as NULL.

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
  IF NULLIF(v_proctor.pid, '') IS NOT NULL THEN RAISE EXCEPTION 'Proctor already has an ID'; END IF;

  SELECT code INTO v_prefix FROM vendors WHERE name = COALESCE(v_proctor.managed_by, v_proctor.vendor) LIMIT 1;
  IF v_prefix IS NULL THEN
    v_prefix := upper(left(COALESCE(v_proctor.managed_by, v_proctor.vendor, 'GEN'), 3));
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
$$;

-- Same empty-string fix applied to re_onboard_proctor's cosmetic note text.
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
    'Re-onboarded from ' || COALESCE(NULLIF(v_old.pid, ''), 'previous record'),
    'In Progress', 0, auth.jwt() ->> 'email', now(), now()
  );

  UPDATE proctors SET status = 'Archived', upd = now() WHERE id = p_old_proctor_id;

  RETURN v_new_id;
END;
$$;
