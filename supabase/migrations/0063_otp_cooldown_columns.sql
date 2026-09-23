-- Both OTP flows (pre-onboarding form, NDA signing) have a lifetime send cap
-- (MAX_RESENDS = 8 in the edge functions) but nothing stopping a candidate from
-- mashing "resend" and burning through that cap in seconds -- there's no timestamp to
-- check a cooldown against, and neither otp_expires_at column can be safely
-- back-derived into one (it would silently break if the expiry duration ever changes).
ALTER TABLE proctors ADD COLUMN form_otp_last_sent_at timestamptz;
ALTER TABLE nda_signing_sessions ADD COLUMN otp_last_sent_at timestamptz;
