-- check_aadhaar_duplicates was GRANTed to `authenticated` broadly (any logged-in role,
-- including vendor), and returns the matching proctor's name/vendor/status for ANY
-- Aadhaar number the caller passes in -- not just proctors the caller manages. Its only
-- legitimate callers are AddProctorPage's single/bulk duplicate check (src/pages/
-- AddProctorPage.tsx), a page RoleGate already restricts to admin/coordinator in the
-- frontend -- but RoleGate is a frontend route guard, not backend enforcement, so a
-- vendor could call this RPC directly (e.g. from the browser console using their own
-- session) and use it as a cross-vendor Aadhaar lookup oracle: probe any Aadhaar number
-- and learn whether it belongs to a proctor at a DIFFERENT vendor, plus that proctor's
-- name and status. Enforce the same role check server-side that the frontend route
-- already implies, mirroring the existing current_user_role() pattern used by
-- schedule_evaluation (migration 0033) and other privileged RPCs.
--
-- (See migration 0042 for a follow-up fix to this same function: the NOT IN check
-- below doesn't actually block a caller with no authenticated session at all, and the
-- default PUBLIC execute grant was never revoked either -- both closed there.)

CREATE OR REPLACE FUNCTION check_aadhaar_duplicates(p_aadhaars text[])
RETURNS TABLE(input_aadhaar text, id text, name text, vendor text, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_user_role() NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  RETURN QUERY
  SELECT a.val, p.id, p.name, COALESCE(p.managed_by, p.vendor), p.status
  FROM unnest(p_aadhaars) AS a(val)
  JOIN proctors p ON p.aadhaar = hash_aadhaar(a.val) AND p.status <> 'Archived';
END;
$$;

GRANT EXECUTE ON FUNCTION check_aadhaar_duplicates(text[]) TO authenticated;
