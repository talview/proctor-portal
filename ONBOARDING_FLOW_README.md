# Secure Onboarding Flow - Complete Implementation

## Overview

This implementation provides a secure, email-based onboarding flow for proctors with OTP verification.

## Flow Diagram

```
Admin (Interview Selects Page)
    ↓
Clicks "📨 Send Form" button
    ↓
[Edge Function: send-form-link]
    ↓
Email #1 sent to proctor: "Click this link to fill your form"
    ↓
Proctor clicks link → Opens /onboarding-form?token={token}
    ↓
[Auto-triggers Edge Function: send-otp]
    ↓
Email #2 sent to proctor: "Your OTP is: 847293"
    ↓
Page shows: "OTP sent to pro***@gmail.com"
    ↓
Proctor enters 6-digit OTP
    ↓
[Edge Function: verify-otp]
    ↓
If OTP valid → Form unlocks
If OTP invalid → Error message
    ↓
Proctor fills form (name, aadhaar, phone, address, etc.)
    ↓
Submit → Status changes to "submitted"
    ↓
Success page displayed
```

## Files Created/Modified

### New Files

1. **`database-migration-otp.sql`** - Database schema for OTP fields
2. **`supabase/functions/send-form-link/index.ts`** - Sends magic link email
3. **`supabase/functions/send-otp/index.ts`** - Generates and sends OTP
4. **`supabase/functions/verify-otp/index.ts`** - Verifies OTP
5. **`src/pages/OnboardingFormPage.tsx`** - Public onboarding form
6. **`EDGE_FUNCTIONS_SETUP.md`** - Deployment guide

### Modified Files

1. **`src/pages/InterviewSelectsPage.tsx`** - Updated "Send Form" button to call Edge Function
2. **`src/App.tsx`** - Added public route for `/onboarding-form`

## Database Schema Changes

New columns added to `proctors` table:

| Column | Type | Description |
|--------|------|-------------|
| `form_link_sent_at` | TIMESTAMPTZ | When form link email was sent |
| `form_link_expires_at` | TIMESTAMPTZ | When link expires (14 days) |
| `form_otp` | VARCHAR(6) | Current OTP (cleared after verification) |
| `form_otp_expires_at` | TIMESTAMPTZ | OTP expiration (10 minutes) |
| `form_otp_attempts` | INTEGER | Failed OTP attempts (max 5) |
| `form_access_count` | INTEGER | Number of times link was accessed |

## Security Features

✅ **Email Verification**: Form link sent only to registered email  
✅ **OTP Protection**: 6-digit OTP required to access form  
✅ **Time-Limited**: Links expire after 14 days, OTP after 10 minutes  
✅ **One-Time Use**: Form can only be submitted once  
✅ **Rate Limiting**: Maximum 5 OTP verification attempts  
✅ **Email Masking**: Shows `pro***@gmail.com` instead of full email  
✅ **Token Validation**: All requests validated against database  

## Configuration Requirements

### 1. Mailgun Setup (Already Done ✅)

- SMTP configured in Supabase Auth settings
- Host: `smtp.mailgun.org`
- Port: `587`

### 2. Environment Variables (Need to Set)

```bash
# In Supabase Edge Functions
MAILGUN_DOMAIN=your-domain.com
MAILGUN_API_KEY=your-api-key
PUBLIC_SITE_URL=https://yourdomain.com

# In Frontend (.env)
VITE_SUPABASE_URL=https://vukijbppuchsmwoyrbjt.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

## Deployment Steps

### Step 1: Run Database Migration

```sql
-- Run in Supabase SQL Editor
-- (Copy from database-migration-otp.sql)
```

### Step 2: Deploy Edge Functions

```bash
supabase link --project-ref vukijbppuchsmwoyrbjt
supabase secrets set MAILGUN_DOMAIN=your-domain.com
supabase secrets set MAILGUN_API_KEY=your-api-key
supabase secrets set PUBLIC_SITE_URL=https://yourdomain.com
supabase functions deploy send-form-link
supabase functions deploy send-otp
supabase functions deploy verify-otp
```

### Step 3: Deploy Frontend

```bash
npm run build
# Deploy to your hosting (Vercel, Netlify, etc.)
```

## Testing

### 1. Test Email Sending

1. Go to Interview Selects page
2. Add a proctor with YOUR email
3. Click "📨 Send Form"
4. Check your inbox for form link email

### 2. Test OTP Flow

1. Click the form link in email
2. Check inbox for OTP email
3. Enter OTP on form page
4. Verify form unlocks

### 3. Test Form Submission

1. Fill all required fields
2. Submit form
3. Verify status changes to "submitted"
4. Verify you can't submit again (one-time use)

## Email Templates

### Form Link Email

- Subject: "Complete Your Talview Proctor Onboarding Form"
- Contains: Magic link button
- Validity: 14 days

### OTP Email

- Subject: "Your OTP: {code} - Talview Proctor Onboarding"
- Contains: 6-digit code in large, bold font
- Validity: 10 minutes

## Cost Estimation

### Mailgun Pricing (for 200-400 emails/day)

- **Daily**: 2 emails per proctor × 200-400 proctors = 400-800 emails/day
- **Monthly**: ~12,000-24,000 emails/month
- **Recommended Plan**: Foundation ($35/month for 50,000 emails)

### Supabase Edge Functions

- **Free Tier**: 500,000 invocations/month
- **Your Usage**: ~600-1,200 invocations/day = ~18,000-36,000/month
- **Cost**: FREE (well within limits)

## Monitoring

### Check Email Delivery

1. Mailgun Dashboard: https://app.mailgun.com/app/logs
2. Look for bounce rates, delivery failures
3. Check spam scores

### Check Edge Function Logs

1. Supabase Dashboard → Edge Functions → Logs
2. Look for errors in send-form-link, send-otp, verify-otp
3. Monitor execution times

### Check Database

```sql
-- Check OTP generation
SELECT email, form_otp, form_otp_expires_at, form_otp_attempts
FROM proctors
WHERE form_link_token IS NOT NULL;

-- Check submission rates
SELECT 
  COUNT(*) FILTER (WHERE form_status = 'shared') as sent,
  COUNT(*) FILTER (WHERE form_status = 'submitted') as submitted
FROM proctors
WHERE interview_stage = 'interview_selected';
```

## Troubleshooting

### Email Not Received

1. Check spam folder
2. Verify email address in database
3. Check Mailgun logs for delivery status
4. Verify SMTP settings in Supabase

### OTP Not Working

1. Check if OTP expired (10 min limit)
2. Verify OTP in database matches entered value
3. Check attempt count (max 5)
4. Request new OTP (click "Resend")

### Form Link Expired

1. Links expire after 14 days
2. Admin must click "Send Form" again
3. New link with new token will be generated

### Multiple Submissions

- Not possible - form checks `form_status = 'submitted'`
- Token is one-time use
- Attempting to resubmit shows error

## Customization

### Change OTP Expiry (Default: 10 minutes)

Edit `supabase/functions/send-otp/index.ts`:

```typescript
otpExpiresAt.setMinutes(otpExpiresAt.getMinutes() + 15) // Change to 15 minutes
```

### Change Link Expiry (Default: 14 days)

Edit `supabase/functions/send-form-link/index.ts`:

```typescript
expiresAt.setDate(expiresAt.getDate() + 7) // Change to 7 days
```

### Change OTP Length (Default: 6 digits)

Edit `supabase/functions/send-otp/index.ts`:

```typescript
function generateOTP(): string {
  return Math.floor(10000 + Math.random() * 90000).toString() // 5 digits
}
```

### Customize Email Templates

Edit the `emailHtml` variable in:
- `send-form-link/index.ts` - Form link email
- `send-otp/index.ts` - OTP email

## Support

For issues:
1. Check Edge Function logs in Supabase
2. Check Mailgun delivery logs
3. Verify database schema with migration SQL
4. Test with your own email first

## Next Steps After Deployment

1. ✅ Test complete flow with your email
2. ✅ Monitor first 10-20 real proctors
3. ✅ Check Mailgun delivery rates (should be >95%)
4. ✅ Adjust email templates if needed
5. ✅ Set up monitoring alerts in Supabase
6. ✅ Document any custom changes for your team
