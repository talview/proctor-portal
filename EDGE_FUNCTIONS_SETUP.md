# Supabase Edge Functions Setup Guide

This guide explains how to deploy the Edge Functions required for the secure onboarding flow.

## Prerequisites

1. ✅ Mailgun SMTP configured in Supabase (already done)
2. Supabase CLI installed: `npm install -g supabase`
3. Logged into Supabase CLI: `supabase login`

## Step 1: Link Your Project

```bash
cd proctor-portal-react
supabase link --project-ref vukijbppuchsmwoyrbjt
```

## Step 2: Set Environment Variables

Go to Supabase Dashboard → Project Settings → Edge Functions → Manage secrets

Add these secrets:

```bash
# Mailgun credentials
MAILGUN_DOMAIN=your-mailgun-domain.com
MAILGUN_API_KEY=your-mailgun-api-key

# Public site URL (for form links)
PUBLIC_SITE_URL=https://yourdomain.com
```

Or via CLI:

```bash
supabase secrets set MAILGUN_DOMAIN=your-mailgun-domain.com
supabase secrets set MAILGUN_API_KEY=your-mailgun-api-key
supabase secrets set PUBLIC_SITE_URL=https://yourdomain.com
```

## Step 3: Deploy Edge Functions

Deploy all three functions:

```bash
# Deploy send-form-link
supabase functions deploy send-form-link

# Deploy send-otp
supabase functions deploy send-otp

# Deploy verify-otp
supabase functions deploy verify-otp
```

## Step 4: Run Database Migration

Run the SQL migration in Supabase SQL Editor:

```bash
cat database-migration-otp.sql
```

Copy the output and run it in: Supabase Dashboard → SQL Editor → New Query

## Step 5: Update Environment Variables (Frontend)

Make sure your `.env` file has:

```env
VITE_SUPABASE_URL=https://vukijbppuchsmwoyrbjt.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

## Step 6: Test the Flow

1. Go to Interview Selects page
2. Import a proctor via CSV (or add manually)
3. Click "📨 Send Form" button
4. Check the proctor's email for:
   - Email #1: Form link
5. Click the form link
6. Check email for:
   - Email #2: OTP code
7. Enter OTP and fill the form
8. Submit and verify status changes to "submitted"

## Testing Locally (Optional)

Run functions locally for testing:

```bash
# Start local Supabase
supabase start

# Serve functions locally
supabase functions serve send-form-link --env-file .env.local
supabase functions serve send-otp --env-file .env.local
supabase functions serve verify-otp --env-file .env.local
```

Create `.env.local` with your secrets:

```env
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_ROLE_KEY=your-local-service-role-key
MAILGUN_DOMAIN=your-mailgun-domain.com
MAILGUN_API_KEY=your-mailgun-api-key
PUBLIC_SITE_URL=http://localhost:5173
```

## Troubleshooting

### Email not sending?

1. Check Mailgun logs: https://app.mailgun.com/app/logs
2. Verify SMTP settings in Supabase: Project Settings → Auth → SMTP
3. Check Edge Function logs: Supabase Dashboard → Edge Functions → Logs

### OTP not working?

1. Check if OTP is being saved to database (check `proctors.form_otp`)
2. Verify OTP expiration time (should be 10 minutes)
3. Check Edge Function logs for errors

### Form link expired?

1. Links expire after 14 days
2. Can be changed in `send-form-link/index.ts` line 35:
   ```typescript
   expiresAt.setDate(expiresAt.getDate() + 14) // Change 14 to desired days
   ```

## Security Notes

- ✅ OTP is 6 digits, valid for 10 minutes
- ✅ Maximum 5 OTP verification attempts
- ✅ Form link expires after 14 days
- ✅ Form can only be submitted once (one-time use)
- ✅ Token is cleared after successful OTP verification
- ✅ All emails sent via your Mailgun SMTP (not Supabase)

## API Endpoints

After deployment, your functions will be available at:

```
https://vukijbppuchsmwoyrbjt.supabase.co/functions/v1/send-form-link
https://vukijbppuchsmwoyrbjt.supabase.co/functions/v1/send-otp
https://vukijbppuchsmwoyrbjt.supabase.co/functions/v1/verify-otp
```

## Email Volume

With Mailgun:
- Free tier: 5,000 emails/month for 3 months
- Foundation: $35/month for 50,000 emails
- For 200-400 emails/day (6,000-12,000/month), Foundation plan is recommended

## Next Steps

1. Deploy the functions
2. Run the database migration
3. Test with a real proctor email
4. Monitor Mailgun delivery rates
5. Customize email templates if needed (edit HTML in Edge Functions)
