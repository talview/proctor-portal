-- Two read-only views so CertificationsPage's Registry tab and EvaluationsPage's
-- Results tab can be paginated server-side via the existing usePaginatedQuery hook.
-- Both pages currently fetch entire tables and build a GROUPED row (one row per
-- proctor, aggregating multiple child rows) client-side -- a plain .range() can't
-- paginate that correctly, since a page boundary would split a proctor's rows across
-- pages instead of across proctors. Each view does the grouping in one pass server-side
-- so PostgREST can filter/search/paginate it exactly like a table.
--
-- `security_invoker = true` (Postgres 15+, this project runs 17.6) makes each view
-- re-evaluate RLS as the querying user, not the view owner -- so proctor_certifications'
-- vendor-scoped policy (migration 0029) and proctor_evaluations'/proctors' vendor-scoped
-- policies (migration 0003) still apply exactly as they do querying the base tables
-- directly. Both views are additive; the underlying tables and existing single-row
-- reads/writes to them are completely unaffected.

-- ============================================================
-- certification_registry -- one row per proctor with >=1 still-valid certification
-- (version_certified >= the customer's current_version), with all of that proctor's
-- valid certifications aggregated into `certifications` (jsonb) and `customer_ids`
-- (a plain array, for a simple .contains() filter by customer).
-- ============================================================
CREATE OR REPLACE VIEW certification_registry
WITH (security_invoker = true) AS
SELECT
  p.pid,
  p.name,
  COALESCE(p.managed_by, p.vendor) AS vendor,
  p.ptype,
  p.vat AS verified_date,
  p.aat AS activated_date,
  array_agg(DISTINCT pc.customer_id) AS customer_ids,
  jsonb_agg(
    jsonb_build_object(
      'customer_id', pc.customer_id,
      'customer_name', pc.customer_name,
      'certified_date', pc.certified_date,
      'version_certified', pc.version_certified
    )
    ORDER BY pc.customer_name
  ) AS certifications
FROM proctor_certifications pc
JOIN customers c ON c.id = pc.customer_id
JOIN proctors p ON p.pid = pc.proctor_id
WHERE pc.status = 'certified'
  AND pc.version_certified >= c.current_version
GROUP BY p.pid, p.name, p.managed_by, p.vendor, p.ptype, p.vat, p.aat;

GRANT SELECT ON certification_registry TO authenticated;

-- ============================================================
-- latest_evaluation_per_proctor -- one row per (proctor_id, eval_type) with completed
-- results (result IS NOT NULL): the highest-attempt_number row, with every earlier
-- attempt for that proctor+eval_type nested as `history` (jsonb array), matching the
-- app's existing "latest attempt, with prior attempts as expandable history" display.
-- Uses window functions (not a correlated subquery) so it's a single pass over the
-- table regardless of how many proctors/attempts exist.
-- ============================================================
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
        'scheduled_date', pe.scheduled_date, 'conducted_date', pe.conducted_date,
        'created_at', pe.created_at, 'panel_user', pe.panel_user, 'comment', pe.comment,
        'score_obtained', pe.score_obtained, 'score_out_of', pe.score_out_of,
        'overridden_by', pe.overridden_by, 'overridden_at', pe.overridden_at
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
