-- proctorService.getStats() fetched every matching proctor row (status, bgv,
-- demo_ready, assessment_ready, vendor, ...) and counted them in JavaScript --
-- the same "fetch everything, filter client-side" pattern already found and fixed
-- in this cycle's CSV export. This replaces it with one Postgres aggregate query
-- (count(*) filter, group by vendor) so the payload back to the client is the
-- small stats object itself, not every row it's derived from -- correct at any
-- table size, not just today's.
--
-- security definer bypasses RLS, so this can't simply trust a client-supplied
-- p_vendor the way the old client-side call did: a vendor-role caller invoking
-- this directly with p_vendor = null would otherwise see every vendor's stats.
-- A vendor caller's scope is forced to their own vendor server-side regardless
-- of what's passed in.
create or replace function get_proctor_stats(p_vendor text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_bgv_due_days constant int := 12;
  v_vendor text;
  v_global jsonb;
  v_by_vendor jsonb;
BEGIN
  IF COALESCE(current_user_role(), '') NOT IN ('admin', 'coordinator', 'vendor') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  v_vendor := p_vendor;
  IF current_user_role() = 'vendor' THEN
    v_vendor := current_user_vendor_name();
  END IF;

  SELECT jsonb_build_object(
    'total', count(*) FILTER (
      WHERE status IS DISTINCT FROM 'Archived' AND interview_stage IS DISTINCT FROM 'interview_selected'
    ),
    'inProgress', count(*) FILTER (
      WHERE status = 'In Progress' AND interview_stage IS DISTINCT FROM 'interview_selected'
    ),
    'verified', count(*) FILTER (
      WHERE status = 'Verified' AND interview_stage IS DISTINCT FROM 'interview_selected'
    ),
    'active', count(*) FILTER (
      WHERE status = 'Active' AND interview_stage IS DISTINCT FROM 'interview_selected'
    ),
    'offboarded', count(*) FILTER (WHERE status = 'Offboarded'),
    'interviewSelects', count(*) FILTER (WHERE interview_stage = 'interview_selected'),
    'bgvMissing', count(*) FILTER (
      WHERE status = 'Active' AND (bgv IS NULL OR bgv = '')
        AND interview_stage IS DISTINCT FROM 'interview_selected'
    ),
    'bgvOverdue', count(*) FILTER (
      WHERE status = 'Active' AND (bgv IS NULL OR bgv = '')
        AND interview_stage IS DISTINCT FROM 'interview_selected'
        AND aat IS NOT NULL AND now() - aat > (v_bgv_due_days || ' days')::interval
    ),
    'demoCert', count(*) FILTER (
      WHERE demo_ready = 'pass' AND status IS DISTINCT FROM 'Archived'
        AND interview_stage IS DISTINCT FROM 'interview_selected'
    ),
    'assessCert', count(*) FILTER (
      WHERE assessment_ready = 'pass' AND status IS DISTINCT FROM 'Archived'
        AND interview_stage IS DISTINCT FROM 'interview_selected'
    )
  )
  INTO v_global
  FROM proctors
  WHERE (v_vendor IS NULL OR vendor = v_vendor);

  -- Vendor keys come from every row regardless of status (matching the previous
  -- allVendors derivation), but each vendor's own counts are scoped to the same
  -- "active" definition as the global stats above.
  SELECT COALESCE(jsonb_object_agg(g.vendor, g.stats), '{}'::jsonb)
  INTO v_by_vendor
  FROM (
    SELECT
      vendor,
      jsonb_build_object(
        'total', count(*) FILTER (
          WHERE status IS DISTINCT FROM 'Archived' AND interview_stage IS DISTINCT FROM 'interview_selected'
        ),
        'inProgress', count(*) FILTER (
          WHERE status = 'In Progress' AND interview_stage IS DISTINCT FROM 'interview_selected'
        ),
        'active', count(*) FILTER (
          WHERE status = 'Active' AND interview_stage IS DISTINCT FROM 'interview_selected'
        ),
        'bgvMissing', count(*) FILTER (
          WHERE status = 'Active' AND (bgv IS NULL OR bgv = '')
            AND interview_stage IS DISTINCT FROM 'interview_selected'
        ),
        'bgvOverdue', count(*) FILTER (
          WHERE status = 'Active' AND (bgv IS NULL OR bgv = '')
            AND interview_stage IS DISTINCT FROM 'interview_selected'
            AND aat IS NOT NULL AND now() - aat > (v_bgv_due_days || ' days')::interval
        ),
        'demoCert', count(*) FILTER (
          WHERE demo_ready = 'pass' AND status IS DISTINCT FROM 'Archived'
            AND interview_stage IS DISTINCT FROM 'interview_selected'
        ),
        'assessCert', count(*) FILTER (
          WHERE assessment_ready = 'pass' AND status IS DISTINCT FROM 'Archived'
            AND interview_stage IS DISTINCT FROM 'interview_selected'
        )
      ) AS stats
    FROM proctors
    WHERE vendor IS NOT NULL AND (v_vendor IS NULL OR vendor = v_vendor)
    GROUP BY vendor
  ) g;

  RETURN v_global || jsonb_build_object('byVendor', v_by_vendor);
END;
$function$;
