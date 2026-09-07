-- Defense in depth for the same issue fixed in the Results table UI: submitting a
-- result against a non-latest attempt would still flip the proctor's live
-- demo_ready/assessment_ready status to whatever that old attempt's result was,
-- even though a later attempt already set the real current status. The UI no longer
-- offers Override on superseded attempts, but the RPC itself should refuse it too,
-- in case it's ever called some other way.

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
  v_max_attempt int;
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

  SELECT MAX(attempt_number) INTO v_max_attempt
  FROM proctor_evaluations
  WHERE proctor_id = v_eval.proctor_id AND eval_type = v_eval.eval_type;

  IF v_eval.attempt_number IS DISTINCT FROM v_max_attempt THEN
    RAISE EXCEPTION 'This is a superseded attempt (a later attempt #% already exists) -- only the latest attempt can be submitted or overridden', v_max_attempt;
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
