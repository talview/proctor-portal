# 🔄 Secure Onboarding Flow - Visual Diagram

## Complete Flow Visualization

```
┌─────────────────────────────────────────────────────────────────┐
│                     SECURE ONBOARDING FLOW                       │
└─────────────────────────────────────────────────────────────────┘

┌───────────────┐
│  ADMIN PANEL  │
│ (Interview    │
│  Selects)     │
└───────┬───────┘
        │
        │ 1. Clicks "📨 Send Form"
        ↓
┌───────────────────────┐
│  Edge Function:       │
│  send-form-link       │
│                       │
│  • Generate token     │
│  • Save to DB         │
│  • Compose email      │
└───────┬───────────────┘
        │
        │ 2. Email sent via Mailgun SMTP
        ↓
┌───────────────────────────────────────────┐
│  📧 EMAIL #1: Form Link                   │
│                                           │
│  Subject: Complete Your Talview Proctor   │
│          Onboarding Form                  │
│                                           │
│  Body:                                    │
│    Hello,                                 │
│    You've been selected...                │
│                                           │
│    [📝 Fill Onboarding Form] ← Button    │
│                                           │
│    Link: /onboarding-form?token=abc123   │
│    Valid: 14 days                         │
└───────┬───────────────────────────────────┘
        │
        │ 3. Proctor clicks link
        ↓
┌───────────────────────┐
│  PUBLIC PAGE:         │
│  OnboardingFormPage   │
│                       │
│  • Parse token        │
│  • Show loading       │
│  • Auto-trigger OTP   │
└───────┬───────────────┘
        │
        │ 4. Auto-calls on page load
        ↓
┌───────────────────────┐
│  Edge Function:       │
│  send-otp             │
│                       │
│  • Validate token     │
│  • Generate 6-digit   │
│  • Save OTP to DB     │
│  • Compose email      │
└───────┬───────────────┘
        │
        │ 5. Email sent via Mailgun SMTP
        ↓
┌───────────────────────────────────────────┐
│  📧 EMAIL #2: OTP                         │
│                                           │
│  Subject: Your OTP: 847293 - Talview     │
│          Proctor Onboarding               │
│                                           │
│  Body:                                    │
│    Your verification code is:             │
│                                           │
│    ╔═══════════════╗                      │
│    ║   8 4 7 2 9 3 ║  ← Large, bold      │
│    ╚═══════════════╝                      │
│                                           │
│    Valid for: 10 minutes                  │
└───────┬───────────────────────────────────┘
        │
        │ 6. Proctor receives OTP
        ↓
┌───────────────────────────────────────────┐
│  ONBOARDING PAGE: OTP Screen              │
│                                           │
│  🔐 OTP Sent!                             │
│                                           │
│  We've sent a 6-digit code to:           │
│  pro***@gmail.com                         │
│                                           │
│  Enter OTP:                               │
│  ┌─────────────────┐                      │
│  │  [0][0][0][0][0][0]  │ ← Input field   │
│  └─────────────────┘                      │
│                                           │
│  [✅ Verify OTP]  [🔄 Resend]            │
└───────┬───────────────────────────────────┘
        │
        │ 7. Enters OTP & clicks Verify
        ↓
┌───────────────────────┐
│  Edge Function:       │
│  verify-otp           │
│                       │
│  • Validate token     │
│  • Check OTP match    │
│  • Check expiry       │
│  • Check attempts     │
│  • Clear OTP from DB  │
│  • Return proctor data│
└───────┬───────────────┘
        │
        │ 8a. If OTP Invalid
        ├────────────────────────┐
        │                        │
        │ 8b. If OTP Valid       │
        ↓                        ↓
┌───────────────┐      ┌───────────────────────────────────────────┐
│  ❌ ERROR     │      │  ONBOARDING PAGE: Form Screen             │
│               │      │                                           │
│  Invalid OTP  │      │  📝 Complete Your Profile                 │
│  Try again    │      │                                           │
│               │      │  Full Name: [____________]                │
│  Attempt: 1/5 │      │  Aadhaar:   [____________] (12 digits)    │
└───────────────┘      │  Phone:     [____________] (10 digits)    │
                       │  Address:   [____________________]        │
                       │  City:      [____________]                │
                       │  State:     [▼ Select state...]           │
                       │  DOB:       [____/____/____]              │
                       │  Gender:    [▼ Select...]                 │
                       │                                           │
                       │  ┌─────────────────────────┐              │
                       │  │ Assignment Details      │              │
                       │  │ Managed By: Sai         │              │
                       │  │ Type: WFO               │              │
                       │  └─────────────────────────┘              │
                       │                                           │
                       │  [✅ Submit Onboarding Form]             │
                       └───────┬───────────────────────────────────┘
                               │
                               │ 9. Fills form & clicks Submit
                               ↓
                       ┌───────────────────────┐
                       │  Database Update:     │
                       │  proctors table       │
                       │                       │
                       │  • name = filled      │
                       │  • aadhaar = filled   │
                       │  • phone = filled     │
                       │  • address = filled   │
                       │  • city = filled      │
                       │  • state = filled     │
                       │  • dob = filled       │
                       │  • gender = filled    │
                       │  • form_status =      │
                       │    'submitted'        │
                       │  • status =           │
                       │    'In Progress'      │
                       │  • stage = 1          │
                       └───────┬───────────────┘
                               │
                               │ 10. Success
                               ↓
                       ┌───────────────────────────────────────────┐
                       │  SUCCESS PAGE                             │
                       │                                           │
                       │  🎉                                       │
                       │  Registration Complete!                   │
                       │                                           │
                       │  Thank you for completing your            │
                       │  onboarding form. Our team will           │
                       │  review your information and              │
                       │  contact you soon.                        │
                       │                                           │
                       │  ✅ Profile submitted successfully        │
                       └───────────────────────────────────────────┘
```

---

## Security Checkpoints

```
┌──────────────────────────────────────────────────────────────┐
│                    SECURITY LAYERS                            │
└──────────────────────────────────────────────────────────────┘

Layer 1: Email Verification
    ↓
    • Link sent ONLY to registered email
    • Email address from CSV/database
    • No manual email entry required
    
Layer 2: Token Validation
    ↓
    • Unique token per proctor
    • Stored in database
    • Validated on every request
    
Layer 3: Link Expiration
    ↓
    • Links expire after 14 days
    • Checked before OTP generation
    • Old links become invalid
    
Layer 4: OTP Generation
    ↓
    • 6-digit random code
    • Generated on link access
    • Stored securely in database
    
Layer 5: OTP Expiration
    ↓
    • Valid for 10 minutes only
    • Timestamp checked on verification
    • Expired OTP rejected
    
Layer 6: Rate Limiting
    ↓
    • Maximum 5 verification attempts
    • Counter incremented on failure
    • Exceeded attempts require new OTP
    
Layer 7: One-Time Use
    ↓
    • Form status = 'submitted'
    • Subsequent submissions blocked
    • Token becomes invalid after use
    
Layer 8: Data Validation
    ↓
    • All fields validated on submit
    • Aadhaar: 12 digits
    • Phone: 10 digits
    • Required fields enforced
```

---

## Database State Changes

```
┌──────────────────────────────────────────────────────────────┐
│                    DATABASE FLOW                              │
└──────────────────────────────────────────────────────────────┘

INITIAL STATE (After CSV Import)
┌─────────────────────────────────────┐
│ Proctor Record                      │
├─────────────────────────────────────┤
│ email: "proctor@gmail.com"          │
│ name: "" (empty)                    │
│ aadhaar: "PENDING_xxxxx"            │
│ phone: "PENDING_xxxxx"              │
│ form_status: "not_sent"             │
│ form_link_token: null               │
│ interview_stage: "interview_selected"│
└─────────────────────────────────────┘
        │
        │ Admin clicks "Send Form"
        ↓
STATE 1 (Form Link Sent)
┌─────────────────────────────────────┐
│ form_status: "shared"               │
│ form_link_token: "abc123..."        │
│ form_link_sent_at: "2026-06-16..."  │
│ form_link_expires_at: "2026-06-30..." │
│ form_shared_at: "2026-06-16..."     │
└─────────────────────────────────────┘
        │
        │ Proctor opens link
        ↓
STATE 2 (OTP Generated)
┌─────────────────────────────────────┐
│ form_otp: "847293"                  │
│ form_otp_expires_at: "...+10 min"  │
│ form_otp_attempts: 0                │
│ form_access_count: 1                │
└─────────────────────────────────────┘
        │
        │ Proctor enters OTP correctly
        ↓
STATE 3 (OTP Verified)
┌─────────────────────────────────────┐
│ form_otp: null (cleared)            │
│ form_otp_expires_at: null           │
│ form_otp_attempts: 0                │
└─────────────────────────────────────┘
        │
        │ Proctor submits form
        ↓
STATE 4 (Form Submitted)
┌─────────────────────────────────────┐
│ name: "John Doe"                    │
│ aadhaar: "123456789012"             │
│ phone: "9876543210"                 │
│ address: "123 Street Name"          │
│ city: "Bangalore"                   │
│ state: "Karnataka"                  │
│ dob: "1995-05-15"                   │
│ gender: "Male"                      │
│ form_status: "submitted"            │
│ status: "In Progress"               │
│ stage: 1                            │
└─────────────────────────────────────┘
```

---

## Error Handling Flow

```
┌──────────────────────────────────────────────────────────────┐
│                    ERROR SCENARIOS                            │
└──────────────────────────────────────────────────────────────┘

ERROR 1: Invalid Token
    ↓
    • Token not found in database
    • Response: "Invalid or expired token"
    • Action: Contact admin for new link
    
ERROR 2: Link Expired
    ↓
    • form_link_expires_at < current time
    • Response: "Form link has expired"
    • Action: Admin sends new form link
    
ERROR 3: Already Submitted
    ↓
    • form_status = 'submitted'
    • Response: "Form has already been submitted"
    • Action: Contact admin if need to update
    
ERROR 4: Invalid OTP
    ↓
    • OTP doesn't match database
    • Response: "Invalid OTP. Try again."
    • Action: Check email for correct OTP
    • Increment: form_otp_attempts
    
ERROR 5: OTP Expired
    ↓
    • form_otp_expires_at < current time
    • Response: "OTP has expired. Request new one."
    • Action: Click "Resend OTP" button
    
ERROR 6: Too Many Attempts
    ↓
    • form_otp_attempts >= 5
    • Response: "Too many failed attempts."
    • Action: Request new OTP (resets counter)
    
ERROR 7: Email Send Failure
    ↓
    • Mailgun API error
    • Response: "Failed to send email"
    • Action: Check Mailgun logs, retry
    
ERROR 8: Validation Error
    ↓
    • Required field empty
    • Aadhaar not 12 digits
    • Phone not 10 digits
    • Response: Field-specific error messages
    • Action: Fix and resubmit
```

---

## Timeline Example

```
┌──────────────────────────────────────────────────────────────┐
│              TYPICAL USER JOURNEY TIMELINE                    │
└──────────────────────────────────────────────────────────────┘

T+0 min    │ Admin clicks "Send Form"
           │ ✅ Email #1 sent
           │
T+2 min    │ Proctor checks email
           │ 📧 Opens form link
           │ ✅ Email #2 (OTP) sent automatically
           │
T+2.5 min  │ Proctor checks email again
           │ 📧 Finds OTP email
           │ 👀 Sees: 847293
           │
T+3 min    │ Enters OTP on form
           │ ✅ OTP verified
           │ 📝 Form unlocks
           │
T+8 min    │ Fills all fields
           │ 📋 Name, Aadhaar, Phone, Address...
           │
T+10 min   │ Clicks "Submit"
           │ ✅ Form submitted successfully
           │ 🎉 Success page shown
           │
           │ Status in DB: "submitted"
           │ Admin sees: ✅ Submitted badge

TOTAL TIME: ~10 minutes (typical)
```

---

## Component Interaction

```
┌──────────────────────────────────────────────────────────────┐
│              COMPONENT ARCHITECTURE                           │
└──────────────────────────────────────────────────────────────┘

┌─────────────────────┐
│  React Frontend     │
│  (Vite + React)     │
└──────┬──────────────┘
       │
       ├──► InterviewSelectsPage.tsx
       │    • Admin clicks "Send Form"
       │    • Calls: /functions/v1/send-form-link
       │
       └──► OnboardingFormPage.tsx
            • Public page (no auth)
            • Step 1: Auto-call /functions/v1/send-otp
            • Step 2: User enters OTP
            • Step 3: Call /functions/v1/verify-otp
            • Step 4: Show form
            • Step 5: Submit to Supabase directly

┌─────────────────────┐
│  Supabase Backend   │
└──────┬──────────────┘
       │
       ├──► Edge Function: send-form-link
       │    • Validates proctor exists
       │    • Generates token
       │    • Updates database
       │    • Sends email via Mailgun
       │
       ├──► Edge Function: send-otp
       │    • Validates token
       │    • Generates 6-digit OTP
       │    • Saves to database
       │    • Sends email via Mailgun
       │
       └──► Edge Function: verify-otp
            • Validates token
            • Checks OTP match
            • Checks expiry & attempts
            • Clears OTP on success
            • Returns proctor data

┌─────────────────────┐
│  Mailgun SMTP       │
└─────────────────────┘
            • Sends Email #1 (form link)
            • Sends Email #2 (OTP)
            • Tracks delivery
            • Handles bounces

┌─────────────────────┐
│  PostgreSQL DB      │
│  (Supabase)         │
└─────────────────────┘
            • Stores proctor data
            • Stores tokens & OTPs
            • Tracks form status
            • Audit trail
```

---

## Success Indicators

```
✅ DEPLOYMENT SUCCESSFUL IF:

1. Email #1 received within 30 seconds
2. Email #2 received within 10 seconds of opening link
3. OTP verification works first try
4. Form submission updates database
5. Status changes to "submitted"
6. Can't submit form twice (one-time use)
7. Mailgun delivery rate >95%
8. Zero Edge Function errors in logs
```

---

**For detailed deployment steps**, see: `DEPLOYMENT_CHECKLIST.md`  
**For troubleshooting**, see: `ONBOARDING_FLOW_README.md`
