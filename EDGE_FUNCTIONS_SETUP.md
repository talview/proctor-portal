# Supabase Edge Functions Setup Guide

This guide covers deploying and configuring the Edge Functions this app depends on.
It previously only listed 3 functions (send-form-link/send-otp/verify-otp) from an
early version of the onboarding flow; the app now ships 18, most of which need at
least one of the secrets below to run correctly.

## Prerequisites

1. Mailgun SMTP/API access configured (used for every outbound email)
2. Supabase CLI installed: `npm install -g supabase`
3. Logged into Supabase CLI: `supabase login`

## Step 1: Link Your Project

```bash
cd proctor-portal-react
supabase link --project-ref vukijbppuchsmwoyrbjt
```

## Step 2: Set Edge Function Secrets

Go to Supabase Dashboard → Project Settings → Edge Functions → Manage secrets, or
use the CLI:

```bash
supabase secrets set MAILGUN_DOMAIN=your-mailgun-domain.com
supabase secrets set MAILGUN_API_KEY=your-mailgun-api-key
supabase secrets set MAILGUN_REPLY_TO=support@yourdomain.com   # optional
supabase secrets set PUBLIC_SITE_URL=https://yourdomain.com
supabase secrets set OTP_HASH_PEPPER="$(openssl rand -hex 32)"
supabase secrets set NDA_HMAC_SECRET="$(openssl rand -hex 32)"
supabase secrets set BULK_WORKER_SECRET="$(openssl rand -hex 32)"
supabase secrets set NDA_WORKER_SECRET="$(openssl rand -hex 32)"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` don't need to be set manually --
every Edge Function has them injected automatically by the Supabase runtime.

| Secret | Required by | Purpose |
|---|---|---|
| `MAILGUN_DOMAIN`, `MAILGUN_API_KEY` | every function that sends email (form links, OTPs, NDA invites, bulk dispatch, user invites) | Mailgun API auth. All app email goes through Mailgun, not Supabase Auth's own SMTP. |
| `MAILGUN_REPLY_TO` | same as above | Optional `Reply-To` header on outgoing mail. Safe to omit. |
| `PUBLIC_SITE_URL` | `invite-user`, `send-form-link`/`dispatch.ts`, bulk-dispatch functions | Base URL used to build links inside emails (form links, invite links). Falls back to the request's `Origin` header, then `http://localhost:3000`, if unset -- set it explicitly in production so links never point at a preview/localhost origin. |
| `OTP_HASH_PEPPER` | `_shared/nda.ts` (`hashOtp`), the pre-onboarding form OTP flow | Server-side secret mixed into every OTP hash via HMAC. A 6-digit OTP has only 1,000,000 possible values, so a bare SHA-256 hash is fully reversible by brute force if a hash ever leaks (e.g. via a DB dump) -- the pepper makes that precomputation attack require the secret too. **Losing/rotating this invalidates every OTP currently in flight** (rotate during low traffic, or rotate only after confirming no session has a live pending OTP). |
| `NDA_HMAC_SECRET` | `nda-session-submit` | HMACs the canonical JSON of a signed NDA session (documents, event log, hashes) into an "Evidence HMAC" printed on the signed certificate PDF -- lets a signed certificate's integrity be verified later against tampering. Rotating this does not invalidate anything already signed (each certificate embeds the HMAC computed at signing time), but a past certificate can no longer be independently re-verified against a *new* secret. |
| `BULK_WORKER_SECRET` | `bulk-dispatch-create`, `bulk-dispatch-retry`, `bulk-dispatch-worker` | Shared secret the worker checks on every invocation (`X-Bulk-Worker-Secret` header) so only the app's own cron tick / immediate-kick calls can trigger a dispatch batch -- not a real user JWT, since Postgres's `pg_net` call has no user session to attach one to. Deliberately narrower than handing the cron job the full service-role key. |
| `NDA_WORKER_SECRET` | `nda-jobs-worker`, `nda-session-submit`, `nda-session-upload-url` | The exact same pattern as `BULK_WORKER_SECRET`, for the NDA signing flow's own durable job queues (`pdf_generation_jobs`, `document_integrity_jobs`) -- checked via `X-Nda-Worker-Secret` on every `nda-jobs-worker` invocation. **This one was previously undocumented** even though the equivalent bulk-dispatch secret always was -- if it's missing or mismatched, `nda-jobs-worker` rejects every call (including the cron's) with 401, and signing/document-verification jobs queue forever with the candidate stuck on a "processing" screen. |

## Step 2b: Set the Database Vault Secrets (for the bulk-dispatch cron)

The 1-minute cron that drains `bulk_dispatch_items` (`drain-bulk-dispatch-queue`,
defined in `supabase/migrations/0036_bulk_dispatch.sql`) calls the
`bulk-dispatch-worker` function via `pg_net`, which runs with no user session and so
can't read Edge Function secrets -- it reads two names out of Supabase Vault instead.
These are **separate** from the `supabase secrets set` values above and must also be
set, once, via SQL Editor or `supabase db query`:

```sql
select vault.create_secret('https://vukijbppuchsmwoyrbjt.supabase.co', 'bulk_dispatch_project_url');
select vault.create_secret('<same value as the BULK_WORKER_SECRET edge function secret above>', 'bulk_worker_secret');
```

If these are missing or wrong, the on-screen bulk-send flow still works (the
immediate `EdgeRuntime.waitUntil` kick fires synchronously from the create/retry
call), but nothing drains a batch too large for one invocation, and a partially-sent
job can appear stuck in "processing" indefinitely.

The NDA signing flow's own cron (`drain-nda-jobs-queue`, `supabase/migrations/0064_nda_job_queues.sql`)
needs one more Vault secret alongside the two above -- it reuses
`bulk_dispatch_project_url` for the URL, but needs its own worker secret (this one
was previously missing from this guide entirely, unlike its bulk-dispatch
equivalent):

```sql
select vault.create_secret('<same value as the NDA_WORKER_SECRET edge function secret above>', 'nda_worker_secret');
```

If this one is missing or wrong, `nda-jobs-worker` rejects every call from the cron
with a 401 (the function's own `X-Nda-Worker-Secret` check never even gets reached)
-- signing/document-verification jobs will queue but never actually process, and a
candidate can be stuck on a "still processing" screen indefinitely with no error
surfaced anywhere in the UI.

## Step 3: Deploy Edge Functions

```bash
supabase functions deploy --project-ref vukijbppuchsmwoyrbjt
```

Or deploy one at a time while iterating on it, e.g.:

```bash
supabase functions deploy send-form-link --project-ref vukijbppuchsmwoyrbjt
```

Current functions (`supabase/functions/*`, `_shared/` excluded -- it's imported
code, not deployed on its own):

- **Pre-onboarding form**: `send-form-link`, `send-otp`, `verify-otp`, `submit-onboarding-form`
- **NDA e-signature**: `nda-session-create`, `nda-session-send-otp`, `nda-session-verify-otp`, `nda-session-consent`, `nda-session-upload-url`, `nda-session-submit`, `nda-session-status`, `nda-template-publish`, `nda-template-set-expiry-policy`
- **User management**: `invite-user`, `delete-user`
- **Bulk dispatch** (mass "send form"/"send onboarding docs"): `bulk-dispatch-create`, `bulk-dispatch-worker`, `bulk-dispatch-retry`, `bulk-dispatch-status`

## Step 4: Run Database Migrations

```bash
supabase db push --linked
```

This applies everything under `supabase/migrations/` in order -- there is no
separate standalone `.sql` file to copy-paste into the SQL Editor anymore; every
schema change (including the OTP/NDA/bulk-dispatch tables and RLS policies) lives
in a numbered migration in that folder.

## Step 5: Frontend Environment Variables

```env
VITE_SUPABASE_URL=https://vukijbppuchsmwoyrbjt.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

See `.env.example`.

## Testing Locally (Optional)

```bash
supabase start
supabase functions serve --env-file .env.local
```

`.env.local` needs the same custom secrets as Step 2 (Mailgun/OTP/NDA/bulk-worker),
plus:

```env
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_ROLE_KEY=your-local-service-role-key
PUBLIC_SITE_URL=http://localhost:5173
```

## Troubleshooting

### Email not sending?

1. Check Mailgun logs: https://app.mailgun.com/app/logs
2. Confirm `MAILGUN_DOMAIN`/`MAILGUN_API_KEY` are set: `supabase secrets list`
3. Check Edge Function logs: Supabase Dashboard → Edge Functions → Logs

### "Server misconfiguration: X is not set"

`OTP_HASH_PEPPER` and `NDA_HMAC_SECRET` are checked at call time with no fallback
(fixed secrets that must exist, unlike `PUBLIC_SITE_URL`'s soft fallback) -- this
error means the named secret was never set, or was set in the wrong project.

### A bulk send never finishes ("processing" forever)

1. Confirm the Vault secrets from Step 2b exist and match the current
   `BULK_WORKER_SECRET`: `select name, updated_at from vault.secrets;`
2. Confirm the cron is actually running: `select * from cron.job_run_details order by start_time desc limit 5;`
3. Check `bulk-dispatch-worker`'s function logs for `401`s (secret mismatch) or
   thrown errors mid-batch.

### Form link expired?

Links expire after 14 days; see `expiresAt.setDate(expiresAt.getDate() + 14)` in
`supabase/functions/send-form-link/index.ts` (or `_shared/dispatch.ts`, which both
`send-form-link` and the bulk-dispatch worker call through).

## Security Notes

- OTP is 6 digits, valid for 10 minutes, hashed with `OTP_HASH_PEPPER` (never stored
  in plaintext or as a bare hash)
- Maximum 5 OTP verification attempts
- Form link expires after 14 days, one-time use
- NDA-signing evidence (documents, event log) is HMAC-sealed with `NDA_HMAC_SECRET`
  at signing time
- All email sent via Mailgun's API (not Supabase Auth's SMTP)
- Two secrets currently set on the live project (`RESEND_API_KEY`, `BOOTSTRAP_SECRET`)
  are not referenced by any function in `supabase/functions/` as of this writing --
  likely leftover from an earlier iteration. Left in place rather than removed here,
  since deleting a live secret is outside the scope of a docs fix; worth confirming
  they're truly dead before removing them.
