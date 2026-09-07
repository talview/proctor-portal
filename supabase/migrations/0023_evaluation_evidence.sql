-- Evaluation Evidence model, per live feedback: whenever a coordinator/admin submits
-- a Demo or Assessment result, they must provide the codes that let the result be
-- independently verified later, and the system builds the result URL from them
-- server-side (so the URL format lives in one place, not duplicated in the frontend
-- and every future caller of it).
--
--   Demo:       https://recruit.talview.com/recruiter/live-session/<session_code>
--   Assessment: https://recruit.talview.com/recruiter/invites/<candidate_id>
--               /assessment-section/<section_id>/answers
--
-- Evidence is required for every result except "No Show" -- there's no session to
-- reference if the proctor never showed up.

ALTER TABLE proctor_evaluations
  ADD COLUMN IF NOT EXISTS session_code text,
  ADD COLUMN IF NOT EXISTS candidate_id text,
  ADD COLUMN IF NOT EXISTS section_id text,
  ADD COLUMN IF NOT EXISTS result_url text;

-- CREATE OR REPLACE with a different parameter count creates a second overload
-- rather than replacing the existing 4-arg version -- drop it first.
DROP FUNCTION IF EXISTS submit_evaluation_result(uuid, text, numeric, text);

CREATE OR REPLACE FUNCTION submit_evaluation_result(
  p_evaluation_id uuid,
  p_result text,
  p_score numeric,
  p_comment text,
  p_session_code text DEFAULT NULL,
  p_candidate_id text DEFAULT NULL,
  p_section_id text DEFAULT NULL
)
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
  v_result_url text;
BEGIN
  IF current_user_role() NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  SELECT * INTO v_eval FROM proctor_evaluations WHERE id = p_evaluation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evaluation not found'; END IF;

  IF v_eval.result IS NOT NULL AND current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can override an existing result';
  END IF;

  IF p_result <> 'No Show' THEN
    IF v_eval.eval_type = 'demo' THEN
      IF NULLIF(p_session_code, '') IS NULL THEN
        RAISE EXCEPTION 'Session Code is required';
      END IF;
      v_result_url := 'https://recruit.talview.com/recruiter/live-session/' || p_session_code;
    ELSE
      IF NULLIF(p_candidate_id, '') IS NULL OR NULLIF(p_section_id, '') IS NULL THEN
        RAISE EXCEPTION 'Candidate ID and Section ID are required';
      END IF;
      v_result_url := 'https://recruit.talview.com/recruiter/invites/' || p_candidate_id
        || '/assessment-section/' || p_section_id || '/answers';
    END IF;
  END IF;

  v_cert_date := CASE WHEN p_result = 'Pass' THEN CURRENT_DATE ELSE NULL END;

  UPDATE proctor_evaluations SET
    result = p_result,
    score_obtained = p_score,
    comment = p_comment,
    certified_date = v_cert_date,
    session_code = NULLIF(p_session_code, ''),
    candidate_id = NULLIF(p_candidate_id, ''),
    section_id = NULLIF(p_section_id, ''),
    result_url = v_result_url,
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

REVOKE ALL ON FUNCTION submit_evaluation_result(uuid, text, numeric, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_evaluation_result(uuid, text, numeric, text, text, text, text) TO authenticated;

-- Same evidence requirement for Client Certification: candidate_id + section_id,
-- result_url built the same way as an Assessment result (same underlying system).
ALTER TABLE proctor_certifications
  ADD COLUMN IF NOT EXISTS candidate_id text,
  ADD COLUMN IF NOT EXISTS section_id text,
  ADD COLUMN IF NOT EXISTS result_url text;
