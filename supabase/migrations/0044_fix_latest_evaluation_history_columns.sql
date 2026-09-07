-- Follow-up to migration 0043, found while wiring EvaluationsPage's Results tab to
-- latest_evaluation_per_proctor: the nested `history` jsonb objects (superseded
-- attempts) were missing `scheduled_time` and `result_url`, both of which the
-- existing history-row rendering (EvaluationsPage.tsx's renderExpandedRow) already
-- reads for every past attempt. The top-level "latest attempt" row already carried
-- both columns correctly -- only the nested history objects needed the fix.

CREATE OR REPLACE VIEW latest_evaluation_per_proctor
WITH (security_invoker = true) AS
SELECT
  id, proctor_id, eval_type, panel_user, scheduled_date, scheduled_time, conducted_date,
  result, attempt_number, comment, created_at, created_by, status, certified_date,
  score_obtained, score_out_of, overridden_by, overridden_at, group_id, session_code,
  candidate_id, section_id, result_url,
  proctor_name, proctor_email, proctor_vendor, proctor_type, history
FROM (
  SELECT
    pe.*,
    p.name AS proctor_name,
    p.email AS proctor_email,
    COALESCE(p.managed_by, p.vendor) AS proctor_vendor,
    p.ptype AS proctor_type,
    ROW_NUMBER() OVER (PARTITION BY pe.proctor_id, pe.eval_type ORDER BY pe.attempt_number DESC) AS rn,
    jsonb_agg(
      jsonb_build_object(
        'id', pe.id, 'attempt_number', pe.attempt_number, 'result', pe.result,
        'scheduled_date', pe.scheduled_date, 'scheduled_time', pe.scheduled_time,
        'conducted_date', pe.conducted_date,
        'created_at', pe.created_at, 'panel_user', pe.panel_user, 'comment', pe.comment,
        'score_obtained', pe.score_obtained, 'score_out_of', pe.score_out_of,
        'overridden_by', pe.overridden_by, 'overridden_at', pe.overridden_at,
        'result_url', pe.result_url, 'certified_date', pe.certified_date
      )
    ) OVER (
      PARTITION BY pe.proctor_id, pe.eval_type
      ORDER BY pe.attempt_number DESC
      ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
    ) AS history
  FROM proctor_evaluations pe
  JOIN proctors p ON p.id = pe.proctor_id
  WHERE pe.result IS NOT NULL
) ranked
WHERE rn = 1;

GRANT SELECT ON latest_evaluation_per_proctor TO authenticated;
