-- Aadhaar must never be stored or displayed in plaintext -- not even to admins.
-- It's also the app's one reliable cross-identity key (a person can have several
-- emails/phones but only one Aadhaar), so hashing must be deterministic (not
-- per-row salted) to preserve exact-match duplicate detection.
--
-- Design: a BEFORE INSERT/UPDATE trigger transparently hashes any raw-looking
-- 12-digit value written to `aadhaar` into an HMAC-SHA256 hex digest, using a
-- secret pepper stored in app_secrets (no grants, RLS enabled with zero
-- policies -- unreachable via the API in any role; only a SECURITY DEFINER
-- function running as the table owner can read it). A plain unsalted hash isn't
-- enough here: Aadhaar is only a 12-digit number, a keyspace small enough to
-- brute-force offline, so the pepper is what actually makes the hash resistant
-- to that.
--
-- This means every existing write path (submit-onboarding-form, AddProctorPage's
-- direct client inserts, re_onboard_proctor's copy-forward) needs NO code
-- changes -- they keep writing what looks like a raw Aadhaar and Postgres hashes
-- it before it ever touches disk. Already-hashed values (64 hex chars) and
-- PENDING_* placeholders don't match the 12-digit pattern, so copy-forward and
-- re-saves are idempotent (hashing only ever happens once per real value).
--
-- The existing partial unique index (uniq_aadhaar_active, WHERE status <>
-- 'Archived', see migration 0007's comment) needs no changes -- it enforces
-- uniqueness on whatever the column holds, and a deterministic hash preserves
-- exact-match equality perfectly.

CREATE TABLE IF NOT EXISTS app_secrets (
  key text PRIMARY KEY,
  value text NOT NULL
);
ALTER TABLE app_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_secrets FROM PUBLIC, anon, authenticated;

-- pgcrypto lives in the `extensions` schema on this project (not `public`), so
-- every call below is schema-qualified rather than relying on search_path.
INSERT INTO app_secrets (key, value)
VALUES ('aadhaar_pepper', encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION hash_aadhaar(p_plain text)
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(extensions.hmac(p_plain, (SELECT value FROM app_secrets WHERE key = 'aadhaar_pepper'), 'sha256'), 'hex')
$$;
REVOKE ALL ON FUNCTION hash_aadhaar(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION sync_aadhaar_hash()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.aadhaar IS NOT NULL AND NEW.aadhaar ~ '^[0-9]{12}$' THEN
    NEW.aadhaar := hash_aadhaar(NEW.aadhaar);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_aadhaar_hash ON proctors;
CREATE TRIGGER trg_sync_aadhaar_hash
  BEFORE INSERT OR UPDATE OF aadhaar ON proctors
  FOR EACH ROW EXECUTE FUNCTION sync_aadhaar_hash();

-- Backfill: re-assigning aadhaar to itself still fires the column-specific
-- trigger above (Postgres fires "UPDATE OF col" whenever col is in the SET
-- list, regardless of whether the value actually changes), hashing every
-- existing plaintext value in place in one pass.
UPDATE proctors SET aadhaar = aadhaar WHERE aadhaar ~ '^[0-9]{12}$';

-- Server-side duplicate check -- the only way the client (or an edge function)
-- can ask "does this Aadhaar already belong to someone" without ever computing
-- or seeing the hash/pepper itself. Accepts a batch so both the single-add and
-- CSV bulk-add flows in AddProctorPage.tsx can use one round trip.
CREATE OR REPLACE FUNCTION check_aadhaar_duplicates(p_aadhaars text[])
RETURNS TABLE(input_aadhaar text, id text, name text, vendor text, status text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT a.val, p.id, p.name, COALESCE(p.managed_by, p.vendor), p.status
  FROM unnest(p_aadhaars) AS a(val)
  JOIN proctors p ON p.aadhaar = hash_aadhaar(a.val) AND p.status <> 'Archived'
$$;
GRANT EXECUTE ON FUNCTION check_aadhaar_duplicates(text[]) TO authenticated;
