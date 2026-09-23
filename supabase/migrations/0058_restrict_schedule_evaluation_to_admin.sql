-- schedule_evaluation allowed 'admin' or 'coordinator', but its only caller
-- (EvaluationsPage.tsx) sits behind a route that's admin-only (/evaluations,
-- App.tsx). No coordinator-reachable UI has ever called this RPC -- the
-- 'coordinator' branch was a dormant permission surface reachable only via
-- direct API access, not an active workflow. Tightened to match the actual
-- product contract already expressed by the route guard.
create or replace function schedule_evaluation(
  p_proctor_id text,
  p_eval_type text,
  p_panel_user text,
  p_scheduled_date date,
  p_scheduled_time text,
  p_score_out_of numeric,
  p_group_id text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
DECLARE
  v_attempt int;
BEGIN
  IF COALESCE(current_user_role(), '') <> 'admin' THEN
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
