-- Cooldown for the new self-service "forgot password" flow
-- (request-password-reset/index.ts) -- same 30s-between-clicks pattern
-- send-otp/nda-session-send-otp already use for their own resend cooldowns
-- (form_otp_last_sent_at / otp_last_sent_at), just for password-reset emails.
alter table users add column if not exists password_reset_last_sent_at timestamptz;
