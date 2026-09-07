-- Supports making nda-session-upload-url's "confirm" step non-blocking: it used to
-- download the whole uploaded file synchronously just to compute its SHA-256 before
-- responding. Now confirm records the client-computed hash immediately and responds
-- right away; a background task (EdgeRuntime.waitUntil) downloads the file separately
-- to compute the real server-side hash and reconcile it against what the client sent --
-- server-side integrity verification is kept, just moved off the response's critical path.

ALTER TABLE nda_session_documents
  ALTER COLUMN content_sha256 DROP NOT NULL,
  ADD COLUMN client_sha256 text,
  ADD COLUMN integrity_status text NOT NULL DEFAULT 'pending'
    CHECK (integrity_status IN ('pending', 'verified', 'mismatch')),
  ADD COLUMN verified_at timestamptz;

-- Every row that predates this migration was hashed synchronously by the old confirm
-- step, so its content_sha256 is already the real, server-verified value.
UPDATE nda_session_documents SET integrity_status = 'verified', verified_at = uploaded_at
  WHERE content_sha256 IS NOT NULL;

-- Widen the event log to record the new async-verification outcomes, and also fix a
-- pre-existing gap: 'signed_pdf_generation_failed' has been logged by
-- nda-session-submit since migration 0034 but was never actually in this CHECK
-- constraint's allow-list -- logEvent() re-threw on the constraint violation, but the
-- call is wrapped in its own try/catch there (see that migration's render_error column),
-- so the failure was only ever visible in function logs, never in the audit trail.
ALTER TABLE nda_signing_events DROP CONSTRAINT nda_signing_events_event_type_check;

ALTER TABLE nda_signing_events ADD CONSTRAINT nda_signing_events_event_type_check
  CHECK (event_type IN ('session_created', 'link_emailed', 'otp_sent', 'otp_verified',
                        'otp_failed', 'nda_viewed', 'consent_given', 'field_signed',
                        'document_uploaded', 'document_removed', 'signed_pdf_generated',
                        'signed_pdf_generation_failed', 'document_verified',
                        'document_integrity_mismatch', 'submitted', 'session_revoked',
                        'session_superseded'));
