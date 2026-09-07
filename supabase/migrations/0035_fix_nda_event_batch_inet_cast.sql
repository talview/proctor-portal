-- 0034's log_nda_events_batch inserted p_ip_address (text) directly into
-- nda_signing_events.ip_address (inet) -- fine when supabase-js/PostgREST inserts a row
-- (it coerces JSON text to the column's real type), but a raw INSERT ... SELECT inside a
-- plpgsql function gets no such implicit cast and fails outright. Cast explicitly.
CREATE OR REPLACE FUNCTION log_nda_events_batch(
  p_session_id uuid,
  p_ip_address text,
  p_user_agent text,
  p_events jsonb
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_session_id::text));

  SELECT COALESCE(MAX(seq), 0) INTO v_base
  FROM nda_signing_events
  WHERE session_id = p_session_id;

  INSERT INTO nda_signing_events (session_id, seq, event_type, ip_address, user_agent, detail)
  SELECT
    p_session_id,
    v_base + ROW_NUMBER() OVER (),
    elem ->> 'event_type',
    p_ip_address::inet,
    p_user_agent,
    COALESCE(elem -> 'detail', '{}'::jsonb)
  FROM jsonb_array_elements(p_events) AS elem;
END;
$$;

REVOKE ALL ON FUNCTION log_nda_events_batch(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_nda_events_batch(uuid, text, text, jsonb) TO service_role;
