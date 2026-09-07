-- demo_eval_link/assessment_link (added by migration 0010) turned out to be a
-- feature that was never actually wired up end-to-end: schedule_evaluation
-- accepted an optional p_link to write into them, but no scheduling UI (individual
-- demo, individual assessment, or bulk assessment) ever passed one, so in
-- practice the "Link" column these fed always rendered "--". The real
-- evidence-link mechanism the app actually uses is proctor_evaluations.result_url,
-- built from session_code (demo) or candidate/section IDs (assessment/
-- certification) -- unrelated to this column pair and unaffected by this migration.
--
-- Revert schedule_evaluation to its pre-0010 signature (p_group_id only, no
-- p_link) and drop the two dead columns.

DROP FUNCTION IF EXISTS schedule_evaluation(text, text, text, date, text, numeric, text, text);

CREATE OR REPLACE FUNCTION schedule_evaluation(
  p_proctor_id text,
  p_eval_type text,
  p_panel_user text,
  p_scheduled_date date,
  p_scheduled_time text,
  p_score_out_of numeric,
  p_group_id text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt int;
BEGIN
  IF current_user_role() NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  IF p_eval_type NOT IN ('demo', 'assessment') THEN
    RAISE EXCEPTION 'Invalid eval_type';
  END IF;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_attempt
  FROM proctor_evaluations
  WHERE proctor_id = p_proctor_id AND eval_type = p_eval_type;

  INSERT INTO proctor_evaluations (
    id, proctor_id, eval_type, panel_user, scheduled_date, scheduled_time,
    score_out_of, result, attempt_number, comment, created_at, created_by, status, group_id
  ) VALUES (
    gen_random_uuid(), p_proctor_id, p_eval_type, p_panel_user, p_scheduled_date, p_scheduled_time,
    p_score_out_of, NULL, v_attempt, '', now(), auth.jwt() ->> 'email', 'scheduled', p_group_id
  );

  IF p_eval_type = 'demo' THEN
    UPDATE proctors SET
      demo_ready = 'scheduled',
      demo_ready_attempt = v_attempt,
      upd = now()
    WHERE id = p_proctor_id;
  ELSE
    UPDATE proctors SET
      assessment_ready = 'scheduled',
      assessment_ready_attempt = v_attempt,
      upd = now()
    WHERE id = p_proctor_id;
  END IF;

  RETURN v_attempt;
END;
$$;

REVOKE ALL ON FUNCTION schedule_evaluation(text, text, text, date, text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION schedule_evaluation(text, text, text, date, text, numeric, text) TO authenticated;

ALTER TABLE proctors DROP COLUMN IF EXISTS demo_eval_link;
ALTER TABLE proctors DROP COLUMN IF EXISTS assessment_link;
