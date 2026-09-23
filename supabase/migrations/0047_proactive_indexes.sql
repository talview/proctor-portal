-- Zero-behavior-change indexes from the Query & Disk I/O audit (findings F-02/F-03/F-04/
-- F-05). None of these change any query's results -- only how Postgres reaches them.
-- All are on tables small enough today that the planner correctly still prefers a
-- sequential scan; these exist so the planner has the option once each table's
-- pending/active row count grows into the hundreds-to-thousands.

-- F-02 / F-05: proctor_evaluations has zero indexes beyond its primary key, despite
-- being the fastest-growing, most heavily filtered table in the app.

-- Upcoming Tasks / Scheduled Events both filter on this first, on every page load.
CREATE INDEX idx_proctor_evaluations_pending
  ON proctor_evaluations (scheduled_date)
  WHERE result IS NULL;

-- Workspace's own-panel scoping (non-admin coordinators) + date filtering together.
CREATE INDEX idx_proctor_evaluations_panel_date
  ON proctor_evaluations (panel_user, scheduled_date);

-- Powers latest_evaluation_per_proctor's PARTITION BY proctor_id, eval_type
-- ORDER BY attempt_number DESC window functions (migration 0043/0044).
CREATE INDEX idx_proctor_evaluations_proctor_type_attempt
  ON proctor_evaluations (proctor_id, eval_type, attempt_number DESC);

-- F-03: the one query polled every 4 seconds (bulk-dispatch-status's
-- 'active_for_proctors' mode) filters proctor_id + status with no supporting index --
-- the only existing indexes on bulk_dispatch_items lead with job_id.
CREATE INDEX idx_bulk_dispatch_items_active_by_proctor
  ON bulk_dispatch_items (proctor_id)
  WHERE status IN ('processing', 'failed');

-- F-04: certification_registry's GROUP BY/jsonb_agg (migration 0043) filters
-- proctor_certifications by status per proctor -- no index currently supports that.
CREATE INDEX idx_proctor_certifications_proctor_status
  ON proctor_certifications (proctor_id, status);
