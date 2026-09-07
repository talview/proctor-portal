-- Live feedback: activation (assign_proctor_id) should only be possible after the
-- proctor has been verified. The function already checked nda_status = 'NDA Signed'
-- but never checked vendor_verified -- meaning a proctor could be given a Proctor ID
-- (and become Active) without ever going through the Verify step. Frontend gating
-- (PipelineActions in ProctorsPage.tsx) is being updated to match in the same change.

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
  IF NOT v_proctor.vendor_verified THEN RAISE EXCEPTION 'Proctor must be verified before activation'; END IF;
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
