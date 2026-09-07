-- Follow-up to migration 0041, found while verifying it live: an entirely
-- unauthenticated caller (anon key only, no login at all) got a real 200 back from
-- check_aadhaar_duplicates, not a permission error. Two independent causes:
--   1. current_user_role() returns NULL when there's no authenticated session (no
--      auth.uid()), and `NULL NOT IN (...)` evaluates to NULL rather than true --
--      plpgsql treats a NULL IF condition as false, so 0041's RAISE never fired for
--      a fully anonymous caller.
--   2. Postgres grants EXECUTE on a new function to PUBLIC by default, and neither the
--      original migration 0032 nor 0041 ever revoked it -- so an anonymous caller had
--      permission to invoke the function in the first place, independent of (1).

CREATE OR REPLACE FUNCTION check_aadhaar_duplicates(p_aadhaars text[])
RETURNS TABLE(input_aadhaar text, id text, name text, vendor text, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF COALESCE(current_user_role(), '') NOT IN ('admin', 'coordinator') THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;

  RETURN QUERY
  SELECT a.val, p.id, p.name, COALESCE(p.managed_by, p.vendor), p.status
  FROM unnest(p_aadhaars) AS a(val)
  JOIN proctors p ON p.aadhaar = hash_aadhaar(a.val) AND p.status <> 'Archived';
END;
$$;

REVOKE ALL ON FUNCTION check_aadhaar_duplicates(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_aadhaar_duplicates(text[]) TO authenticated;
