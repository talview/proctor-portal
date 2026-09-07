-- The legacy onboarding-form OTP (send-otp/verify-otp, used by OnboardingFormPage --
-- distinct from the NDA signing OTP, which already does this correctly) generated
-- codes with Math.random() (not cryptographically secure), stored them in plaintext
-- (form_otp), and reset the per-code attempt counter on every resend with no cap on
-- how many times a resend could be requested -- so the real attempt budget across a
-- link's lifetime was effectively unbounded.
--
-- Mirrors the exact design already used and reviewed for NDA's otp_sha256/
-- otp_failed_attempts/otp_failed_lifetime/otp_send_count (see nda_signing_sessions):
-- crypto.getRandomValues-based generation, hashed storage, a per-code attempt cap
-- that resets on resend, a lifetime attempt cap that never resets, and a lifetime
-- send-count cap so resending doesn't grant unlimited fresh attempt budgets.

ALTER TABLE proctors ADD COLUMN IF NOT EXISTS form_otp_hash text;
ALTER TABLE proctors ADD COLUMN IF NOT EXISTS form_otp_failed_lifetime integer NOT NULL DEFAULT 0;
ALTER TABLE proctors ADD COLUMN IF NOT EXISTS form_otp_send_count integer NOT NULL DEFAULT 0;

-- Plaintext column retired -- nothing should ever read/write this again.
ALTER TABLE proctors DROP COLUMN IF EXISTS form_otp;
