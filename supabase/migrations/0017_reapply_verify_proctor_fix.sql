-- Re-applies the verify_proctor() fix from migration 0012 verbatim. Found by the same
-- systematic audit that caught 0006 and 0007: production's verify_proctor was still the
-- pre-0012 version -- vacuous `IS NOT NULL` doc check (these columns default to '', not
-- NULL, so this never actually blocked anything) and admin-only (vendors could not
-- verify their own proctors at all, despite the app's UI and this session's explicit
-- design decision assuming they could). CREATE OR REPLACE makes this safe to re-run
-- regardless of current live state.
--
-- Original 0012 description, unchanged below: NULLIF gate (doc_* defaults to '', not
-- NULL) + widen to vendor.

CREATE OR REPLACE FUNCTION verify_proctor(p_proctor_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proctor proctors%ROWTYPE;
  v_docs_ok boolean;
BEGIN
  IF current_user_role() NOT IN ('admin', 'vendor') THEN
    RAISE EXCEPTION 'Only admins and vendors can verify proctors';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  IF current_user_role() = 'vendor'
     AND v_proctor.vendor IS DISTINCT FROM current_user_vendor_name()
     AND v_proctor.managed_by IS DISTINCT FROM current_user_vendor_name() THEN
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
$$;

DROP FUNCTION IF EXISTS trigger_proctor_nda(text);

REVOKE ALL ON FUNCTION verify_proctor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_proctor(text) TO authenticated;
