-- NDA e-signature system: versioned templates, signing sessions, append-only audit
-- events, and per-document upload records. All writes to these four tables happen
-- through service-role edge functions -- no INSERT/UPDATE/DELETE grants to anyone,
-- including admin, so the audit trail can't be tampered with from the client.
--
-- Also bundled: two pre-existing bugs that block this feature from working at all:
--   1. verify_proctor()'s document-completeness check compares against NULL, but
--      doc_* columns default to '' (same class of bug 0006 already fixed for pid).
--   2. verify_proctor() was admin-only; the business now wants vendors to verify
--      their own proctors too, once NDA + documents are complete.
-- And trigger_proctor_nda() is dropped -- it only ever flipped status flags and
-- never sent anything; superseded by the nda-session-create edge function.

CREATE TABLE nda_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version           integer NOT NULL,
  label             text NOT NULL,
  storage_bucket    text NOT NULL DEFAULT 'nda-signing',
  storage_path      text NOT NULL UNIQUE,
  content_sha256    text NOT NULL,
  byte_size         bigint NOT NULL,
  page_count        integer NOT NULL,
  -- [{ field_key, kind, page_index, x, y, w, h, page_w, page_h, page_rotation }]
  -- x/y/w/h normalised 0..1 against the visual (post-rotation) page box.
  -- kind is a fixed vocabulary: 'signature' | 'date' | 'full_name' | 'place'.
  field_map         jsonb NOT NULL,
  is_active         boolean NOT NULL DEFAULT false,
  published_by      text NOT NULL,
  published_at      timestamptz NOT NULL DEFAULT now(),
  retired_at        timestamptz,
  CONSTRAINT nda_templates_version_uniq UNIQUE (version),
  CONSTRAINT nda_templates_fieldmap_nonempty CHECK (jsonb_array_length(field_map) > 0)
);

CREATE UNIQUE INDEX nda_templates_one_active ON nda_templates ((true)) WHERE is_active;

CREATE TABLE nda_signing_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proctor_id             text NOT NULL REFERENCES proctors(id) ON DELETE CASCADE,
  template_id            uuid NOT NULL REFERENCES nda_templates(id),
  template_sha256        text NOT NULL,

  -- proctors.name/email are admin-editable after the fact; snapshot so the
  -- certificate never silently changes underneath a completed signature.
  signer_name_snapshot   text NOT NULL,
  signer_email_snapshot  text NOT NULL,

  session_token_sha256   text NOT NULL UNIQUE,
  session_expires_at     timestamptz NOT NULL,
  step_token_sha256      text,
  step_token_expires_at  timestamptz,

  otp_sha256             text,
  otp_expires_at         timestamptz,
  otp_failed_attempts    integer NOT NULL DEFAULT 0,
  otp_failed_lifetime    integer NOT NULL DEFAULT 0,
  otp_send_count         integer NOT NULL DEFAULT 0,

  status                 text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','otp_verified','consented','signing','signed','completed',
                       'expired','revoked')),

  signed_pdf_path        text,
  signed_pdf_sha256      text,
  certificate_path       text,
  certificate_sha256     text,
  evidence_hmac          text,

  superseded_by          uuid REFERENCES nda_signing_sessions(id),
  revoked_at             timestamptz,
  created_by             text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- At most one live (non-terminal) session per proctor -- this is what makes
-- "resending Send Docs revokes the prior link" enforceable at the DB level,
-- not just a convention the edge function has to remember to honor.
CREATE UNIQUE INDEX nda_sessions_one_live
  ON nda_signing_sessions (proctor_id)
  WHERE status IN ('created','otp_verified','consented','signing','signed');
CREATE INDEX nda_sessions_proctor ON nda_signing_sessions (proctor_id);

CREATE TABLE nda_signing_events (
  id            bigserial PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES nda_signing_sessions(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  event_type    text NOT NULL
    CHECK (event_type IN ('session_created','link_emailed','otp_sent','otp_verified',
                          'otp_failed','nda_viewed','consent_given','field_signed',
                          'document_uploaded','signed_pdf_generated','submitted',
                          'session_revoked','session_superseded')),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  ip_address    inet,
  user_agent    text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT nda_events_seq_uniq UNIQUE (session_id, seq)
);
CREATE INDEX nda_events_session ON nda_signing_events (session_id, seq);

CREATE TABLE nda_session_documents (
  session_id    uuid NOT NULL REFERENCES nda_signing_sessions(id) ON DELETE CASCADE,
  doc_kind      text NOT NULL
    CHECK (doc_kind IN ('resume','passport_photo','grad_cert','aadhaar_copy',
                        'pan_copy','eye_test')),
  storage_path  text NOT NULL UNIQUE,
  content_sha256 text NOT NULL,
  byte_size     bigint NOT NULL,
  content_type  text NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, doc_kind)
);

-- updated_at maintained by trigger, not by callers. The existing set_updated_at()
-- is hardcoded to proctors' legacy `upd` column name, so this table gets its own.
CREATE OR REPLACE FUNCTION set_updated_at_generic()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_nda_sessions_upd BEFORE UPDATE ON nda_signing_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_generic();

ALTER TABLE nda_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE nda_signing_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nda_signing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nda_session_documents ENABLE ROW LEVEL SECURITY;

-- Read-only for admin/coordinator (everything) and vendor (their own proctors'
-- sessions/events/documents, and templates -- templates aren't proctor-scoped
-- so any authenticated user can see which one is active). No INSERT/UPDATE/DELETE
-- policy on any of these four tables for any role: every write goes through a
-- service-role edge function.
CREATE POLICY nda_templates_select ON nda_templates FOR SELECT TO authenticated
  USING (true);

CREATE POLICY nda_sessions_select ON nda_signing_sessions FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('admin', 'coordinator')
    OR EXISTS (
      SELECT 1 FROM proctors p WHERE p.id = nda_signing_sessions.proctor_id
        AND (p.vendor = current_user_vendor_name() OR p.managed_by = current_user_vendor_name())
    )
  );

CREATE POLICY nda_events_select ON nda_signing_events FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('admin', 'coordinator')
    OR EXISTS (
      SELECT 1 FROM nda_signing_sessions s
      JOIN proctors p ON p.id = s.proctor_id
      WHERE s.id = nda_signing_events.session_id
        AND (p.vendor = current_user_vendor_name() OR p.managed_by = current_user_vendor_name())
    )
  );

CREATE POLICY nda_documents_select ON nda_session_documents FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('admin', 'coordinator')
    OR EXISTS (
      SELECT 1 FROM nda_signing_sessions s
      JOIN proctors p ON p.id = s.proctor_id
      WHERE s.id = nda_session_documents.session_id
        AND (p.vendor = current_user_vendor_name() OR p.managed_by = current_user_vendor_name())
    )
  );

-- New bucket for signed output + templates. No anon policies at all (unlike
-- bgv-documents/nda-documents) -- proctor-facing reads/writes go through
-- edge functions using signed URLs, never a direct client storage grant.
INSERT INTO storage.buckets (id, name, public) VALUES ('nda-signing', 'nda-signing', false)
  ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Allow authenticated read nda-signing" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'nda-signing');
CREATE POLICY "Allow authenticated upload nda-signing" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'nda-signing');

-- Fix verify_proctor(): NULLIF gate (doc_* defaults to '', not NULL) + widen to vendor.
CREATE OR REPLACE FUNCTION verify_proctor(p_proctor_id text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proctor proctors%ROWTYPE;
  v_docs_ok boolean;
BEGIN
  IF current_user_role() NOT IN ('admin', 'vendor') THEN
    RAISE EXCEPTION 'Only admins and vendors can verify proctors';
  END IF;

  SELECT * INTO v_proctor FROM proctors WHERE id = p_proctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proctor not found'; END IF;

  IF current_user_role() = 'vendor'
     AND v_proctor.vendor IS DISTINCT FROM current_user_vendor_name()
     AND v_proctor.managed_by IS DISTINCT FROM current_user_vendor_name() THEN
    RAISE EXCEPTION 'You can only verify your own vendor''s proctors';
  END IF;

  v_docs_ok := NULLIF(v_proctor.doc_resume, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_passport_photo, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_grad_cert, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_aadhaar_copy, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_pan_copy, '') IS NOT NULL
    AND NULLIF(v_proctor.doc_eye_test, '') IS NOT NULL;

  IF NOT v_docs_ok THEN RAISE EXCEPTION 'Documents not complete'; END IF;
  IF v_proctor.nda_status IS DISTINCT FROM 'NDA Signed' THEN RAISE EXCEPTION 'NDA not signed'; END IF;
  IF v_proctor.vendor_verified THEN RAISE EXCEPTION 'Already verified'; END IF;

  UPDATE proctors SET
    vendor_verified = true,
    vendor_verified_by = auth.jwt() ->> 'email',
    vendor_verified_at = now(),
    status = 'Verified',
    stage = 2,
    upd = now()
  WHERE id = p_proctor_id;
END;
$$;

DROP FUNCTION IF EXISTS trigger_proctor_nda(text);

REVOKE ALL ON FUNCTION verify_proctor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_proctor(text) TO authenticated;
