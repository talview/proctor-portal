-- The NDA signing flow logged one audit event at a time via a SELECT COUNT + INSERT
-- per event (see _shared/nda.ts's old logEvent), which meant a document with N fields
-- cost 2*N sequential Postgres round-trips inside one request. This collapses any
-- number of events for one session into a single round-trip: compute the next `seq`
-- once, then insert every row in one INSERT ... SELECT over a JSON array.
--
-- pg_advisory_xact_lock serializes concurrent calls for the *same* session so two
-- overlapping batches can never race on the (session_id, seq) unique constraint --
-- shouldn't happen given the CAS status locking elsewhere, but it's a cheap guarantee
-- that also lets us drop the old retry-3-times-on-conflict loop entirely.
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
    p_ip_address,
    p_user_agent,
    COALESCE(elem -> 'detail', '{}'::jsonb)
  FROM jsonb_array_elements(p_events) AS elem;
END;
$$;

REVOKE ALL ON FUNCTION log_nda_events_batch(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_nda_events_batch(uuid, text, text, jsonb) TO service_role;

-- Lets a background PDF-generation failure be surfaced to the signer (via
-- handleFinalize's poll) instead of leaving the session silently stuck in 'signing'.
ALTER TABLE nda_signing_sessions ADD COLUMN IF NOT EXISTS render_error text;
