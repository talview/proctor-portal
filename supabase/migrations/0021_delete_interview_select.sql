-- Feature request from live-testing feedback: admin needs a way to remove an Interview
-- Selects entry (e.g. a bad CSV import, a candidate who's no longer being considered).
-- There is no DELETE policy on proctors at all today -- every other "removal" in this
-- app is a soft-archive (offboard_proctor), which makes sense for real onboarded
-- proctors but not for a row that's still just an interview-selected placeholder with
-- no onboarding history. Scoped narrowly via a SECURITY DEFINER function rather than a
-- blanket RLS DELETE policy: admin-only, and only while the row is still at the
-- interview_stage = 'interview_selected' stage, so this can never be used to delete a
-- proctor who has actually progressed past this point.

CREATE OR REPLACE FUNCTION delete_interview_select(p_proctor_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proctor proctors%ROWTYPE;
BEGIN
  IF current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can delete an interview select entry';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found'; END IF;

  IF v_proctor.interview_stage IS DISTINCT FROM 'interview_selected' THEN
    RAISE EXCEPTION 'This record has already progressed past Interview Selects and cannot be deleted here';
  END IF;

  DELETE FROM proctors WHERE id = p_proctor_id;
END;
$$;

REVOKE ALL ON FUNCTION delete_interview_select(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_interview_select(text) TO authenticated;
