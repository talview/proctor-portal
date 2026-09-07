-- nda-session-upload-url's "remove" action logs event_type 'document_removed', but
-- the CHECK constraint from 0012 never included it. logEvent() re-throws on any
-- non-unique-violation error (see _shared/nda.ts), so this wasn't just a missing
-- audit entry: every document removal actually deleted the storage object and the
-- nda_session_documents row *successfully*, then the function threw on the
-- constraint violation trying to log it, and the caller saw a failure response for
-- an action that had, in fact, already completed.

ALTER TABLE nda_signing_events DROP CONSTRAINT nda_signing_events_event_type_check;

ALTER TABLE nda_signing_events ADD CONSTRAINT nda_signing_events_event_type_check
  CHECK (event_type IN ('session_created','link_emailed','otp_sent','otp_verified',
                        'otp_failed','nda_viewed','consent_given','field_signed',
                        'document_uploaded','document_removed','signed_pdf_generated',
                        'submitted','session_revoked','session_superseded'));
