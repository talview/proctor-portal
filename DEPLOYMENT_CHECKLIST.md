# 🚀 Deployment Checklist - Secure Onboarding Flow

Use this checklist to deploy the secure onboarding flow step-by-step.

---

## ✅ Pre-Deployment (Already Done)

- [x] Mailgun SMTP configured in Supabase Auth settings
- [x] Code implementation complete
- [x] Documentation created

---

## 📋 Deployment Steps

### 1️⃣ Database Setup

- [ ] Open Supabase SQL Editor
- [ ] Copy content from `database-migration-otp.sql`
- [ ] Run the migration
- [ ] Verify new columns exist:
  ```sql
  SELECT column_name 
  FROM information_schema.columns 
  WHERE table_name = 'proctors' 
  AND column_name LIKE 'form_%';
  ```

**Expected output**: 6 columns (form_link_sent_at, form_link_expires_at, form_otp, form_otp_expires_at, form_otp_attempts, form_access_count)

---

### 2️⃣ Get Mailgun Credentials

- [ ] Login to Mailgun: https://app.mailgun.com
- [ ] Go to: Sending → Domains
- [ ] Note your domain: `____________________`
- [ ] Go to: Settings → API Keys
- [ ] Copy your API key: `____________________`

---

### 3️⃣ Set Environment Variables

**Option A: Via Supabase CLI**

```bash
supabase login
supabase link --project-ref vukijbppuchsmwoyrbjt
supabase secrets set MAILGUN_DOMAIN=your-domain.com
supabase secrets set MAILGUN_API_KEY=your-api-key
supabase secrets set PUBLIC_SITE_URL=https://yourdomain.com
```

**Option B: Via Supabase Dashboard**

- [ ] Go to: Project Settings → Edge Functions → Manage secrets
- [ ] Add secret: `MAILGUN_DOMAIN` = `your-domain.com`
- [ ] Add secret: `MAILGUN_API_KEY` = `your-api-key`
- [ ] Add secret: `PUBLIC_SITE_URL` = `https://yourdomain.com`

---

### 4️⃣ Deploy Edge Functions

```bash
cd proctor-portal-react

# Deploy all three functions
supabase functions deploy send-form-link
supabase functions deploy send-otp
supabase functions deploy verify-otp
```

**Verify deployment:**
- [ ] Check: Supabase Dashboard → Edge Functions
- [ ] Confirm 3 functions are listed and "Deployed"

---

### 5️⃣ Frontend Environment Variables

- [ ] Verify `.env` file has:
  ```env
  VITE_SUPABASE_URL=https://vukijbppuchsmwoyrbjt.supabase.co
  VITE_SUPABASE_ANON_KEY=your-anon-key
  ```

---

### 6️⃣ Deploy Frontend

```bash
npm run build
# Deploy to your hosting platform
```

---

## 🧪 Testing

### Test 1: Send Form Link

- [ ] Login to admin panel
- [ ] Go to Interview Selects page
- [ ] Add a proctor with YOUR email
- [ ] Click "📨 Send Form" button
- [ ] Check success message appears
- [ ] **Check your email inbox** for form link email

**Expected**: Email with subject "Complete Your Talview Proctor Onboarding Form"

---

### Test 2: OTP Flow

- [ ] Click the form link in email
- [ ] Page loads showing "OTP sent to..."
- [ ] **Check your email inbox** for OTP email
- [ ] See 6-digit code in email

**Expected**: Email with subject "Your OTP: xxxxxx - Talview Proctor Onboarding"

---

### Test 3: Form Submission

- [ ] Enter OTP on form page
- [ ] Click "Verify OTP"
- [ ] Form unlocks showing all fields
- [ ] Fill all required fields
- [ ] Click "Submit Onboarding Form"
- [ ] See success message

**Expected**: "🎉 Registration Complete!" page

---

### Test 4: Verify in Database

```sql
-- Check proctor was updated
SELECT 
  email,
  name,
  form_status,
  status,
  form_link_sent_at,
  form_otp
FROM proctors
WHERE email = 'your-test-email@gmail.com';
```

**Expected**:
- form_status = 'submitted'
- status = 'In Progress'
- name filled in
- form_otp = NULL (cleared after verification)

---

### Test 5: One-Time Use Verification

- [ ] Try opening the form link again
- [ ] Try submitting OTP again

**Expected**: Error message "Form has already been submitted"

---

## 📊 Monitoring Setup

### Mailgun Monitoring

- [ ] Go to: https://app.mailgun.com/app/logs
- [ ] Check delivery rate (should be >95%)
- [ ] Look for bounces or failures
- [ ] Set up alerts for failed deliveries

### Supabase Monitoring

- [ ] Go to: Supabase Dashboard → Edge Functions → Logs
- [ ] Check for errors in last 24 hours
- [ ] Set up log alerts for errors

### Database Monitoring

```sql
-- Daily statistics query
SELECT 
  COUNT(*) FILTER (WHERE form_status = 'shared') as links_sent,
  COUNT(*) FILTER (WHERE form_status = 'submitted') as forms_submitted,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE form_status = 'submitted') / 
    NULLIF(COUNT(*) FILTER (WHERE form_status = 'shared'), 0),
    1
  ) as submission_rate_percent
FROM proctors
WHERE interview_stage = 'interview_selected'
AND form_link_sent_at > NOW() - INTERVAL '7 days';
```

---

## 🐛 Troubleshooting Guide

### Issue: Email not received

**Check:**
1. [ ] Spam folder
2. [ ] Mailgun logs (app.mailgun.com/app/logs)
3. [ ] Email address in database is correct
4. [ ] SMTP settings in Supabase (Project Settings → Auth → SMTP)
5. [ ] Edge Function logs for errors

**Fix:**
- Verify Mailgun domain is verified
- Check DNS records for domain
- Resend from Interview Selects page

---

### Issue: OTP not working

**Check:**
1. [ ] OTP expiry (10 minutes)
2. [ ] OTP in database matches entered value
3. [ ] Attempt count (max 5)
4. [ ] Edge Function logs

**Fix:**
- Click "Resend OTP" button
- Check database: `SELECT form_otp, form_otp_expires_at FROM proctors WHERE email = '...'`

---

### Issue: Form link expired

**Check:**
1. [ ] form_link_expires_at in database (14 days from sent date)

**Fix:**
- Admin clicks "Send Form" again
- New link generated with new expiry

---

### Issue: Edge Function error

**Check:**
1. [ ] Supabase Dashboard → Edge Functions → Logs
2. [ ] Environment variables set correctly
3. [ ] Mailgun API key valid

**Fix:**
- Redeploy functions: `supabase functions deploy <function-name>`
- Check secrets: `supabase secrets list`

---

## 📈 Success Metrics

After 1 week, check:

- [ ] **Delivery Rate**: >95% (check Mailgun)
- [ ] **Submission Rate**: >70% (forms submitted / links sent)
- [ ] **Error Rate**: <5% (check Edge Function logs)
- [ ] **Avg. Time to Submit**: <24 hours

---

## 🎉 Deployment Complete!

- [ ] All tests passed
- [ ] Monitoring set up
- [ ] Team informed
- [ ] Documentation shared

**Next**: Monitor for first 10-20 real proctors and adjust as needed.

---

## 📞 Support Contacts

- **Supabase Issues**: Check Supabase Dashboard logs
- **Mailgun Issues**: https://www.mailgun.com/support/
- **Code Issues**: Check ONBOARDING_FLOW_README.md

---

**Deployment Date**: ________________  
**Deployed By**: ________________  
**Status**: ⬜ Pending / ⬜ In Progress / ⬜ Complete
