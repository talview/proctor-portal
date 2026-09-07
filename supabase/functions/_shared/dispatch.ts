// Shared per-recipient dispatch logic for Pre-Onboarding Form and Onboarding Docs --
// used by both the original single-proctor "Send"/"Resend" edge functions
// (send-form-link, nda-session-create) and bulk-dispatch-worker, so eligibility rules,
// session/token logic, Mailgun config, and lifecycle-status writes exist in exactly one
// place each, not duplicated across the single-send and bulk-send paths.
import { adminClient, sendMailgunEmail, randomToken, hashToken, logEvent, resolveSessionExpiry } from './nda.ts'

export interface DispatchResult {
  success: boolean
  error?: string
}

function siteBaseUrl(originHeader: string | null): string {
  return (Deno.env.get('PUBLIC_SITE_URL') || originHeader || 'http://localhost:3000').replace(/\/$/, '')
}

/**
 * "Send"/"Resend" the pre-onboarding form link. Reuses the existing token rather than
 * minting a new one if the proctor already has one -- this alone is what prevents a
 * repeated send (whether a manual resend or a retried bulk dispatch) from creating a
 * second "active" link; it just refreshes the status/expiry on the same token.
 */
export async function dispatchPreOnboardingForm(
  supabase: ReturnType<typeof adminClient>,
  proctor: { id: string; name?: string | null; email?: string | null; form_link_token?: string | null },
  originHeader: string | null
): Promise<DispatchResult> {
  try {
    if (!proctor.email) return { success: false, error: 'Proctor has no email on file' }

    const token = proctor.form_link_token || crypto.randomUUID().replace(/-/g, '')
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + 24)

    const formUrl = `${siteBaseUrl(originHeader)}/onboarding-form?token=${token}`
    const recipientName = proctor.name || 'there'

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; padding: 0; background: #ffffff; color: #1f2937; font-family: Arial, sans-serif; }
    .container { max-width: 600px; margin: 0 auto; padding: 24px; }
    .card { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
    .header { padding: 20px 24px; border-bottom: 1px solid #e5e7eb; }
    .header h1 { margin: 0; font-size: 20px; color: #111827; }
    .content { padding: 24px; line-height: 1.6; font-size: 15px; }
    .button { display: inline-block; background: #2563eb; color: #ffffff !important; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 16px 0; }
    .link { word-break: break-all; color: #2563eb; }
    .footer { padding: 16px 24px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
    .meta { margin-top: 16px; font-size: 13px; color: #4b5563; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <h1>Talview Proctor Pre-Onboarding</h1>
      </div>
      <div class="content">
        <p>Hello ${recipientName},</p>
        <p>Please complete your pre-onboarding form using the secure link below.</p>
        <p>
          <a href="${formUrl}" class="button" target="_blank" rel="noopener noreferrer">Open Pre-Onboarding Form</a>
        </p>
        <p class="meta">
          If the button does not work, use this link:
        </p>
        <p>
          <a href="${formUrl}" class="link" target="_blank" rel="noopener noreferrer">${formUrl}</a>
        </p>
        <p class="meta">
          This link expires in 24 hours and can be used once. An OTP will be sent to this email address when the form is opened.
        </p>
        <p class="meta">
          If you need help, contact your coordinator.
        </p>
      </div>
      <div class="footer">
        Sent automatically by Talview Proctor Portal.
      </div>
    </div>
  </div>
</body>
</html>
    `
    const emailText = `Hello ${recipientName},

Please complete your pre-onboarding form using the secure link below:
${formUrl}

If the button does not work, copy and paste the link into your browser.

This link expires in 24 hours and can be used once. An OTP will be sent to this email when you open the form.

If you have any questions, please contact your coordinator.

Sent automatically by Talview Proctor Portal.`

    // Send first -- only record the link as "shared" once the email has actually gone
    // out. This used to update the proctor row before sending, so a Mailgun failure
    // still left form_status:'shared' (and a real expiry window ticking down) for a
    // link nobody ever received -- the admin would see a correct "failed" error message
    // but the row's own status badge would contradict it.
    await sendMailgunEmail(proctor.email, 'Action required: complete your Talview pre-onboarding form', emailHtml, emailText)

    const { error: updateError } = await supabase
      .from('proctors')
      .update({
        form_link_token: token,
        form_status: 'shared',
        form_link_sent_at: new Date().toISOString(),
        form_link_expires_at: expiresAt.toISOString(),
        form_shared_at: new Date().toISOString(),
        upd: new Date().toISOString(),
      })
      .eq('id', proctor.id)
    if (updateError) throw updateError

    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

/**
 * "Send"/"Resend Docs" -- creates (or supersedes) a signing session covering both NDA
 * signing and the 6 document uploads, and emails the one link. `req` may be null (the
 * bulk worker has no live per-recipient request to attribute IP/user-agent to; the
 * events it logs simply carry no IP for that reason, same as any other server-initiated
 * action).
 */
export async function dispatchOnboardingDocs(
  supabase: ReturnType<typeof adminClient>,
  proctor: { id: string; name?: string | null; email?: string | null; demo_ready?: string | null; assessment_ready?: string | null },
  template: { id: string; content_sha256: string; expiry_policy: string },
  createdBy: string,
  originHeader: string | null,
  req: Request | null
): Promise<DispatchResult> {
  try {
    if (!proctor.email) return { success: false, error: 'Proctor has no email on file' }
    if (proctor.demo_ready !== 'pass' || proctor.assessment_ready !== 'pass') {
      return { success: false, error: 'Assessment and Demo must both pass first' }
    }

    // Supersede any still-live session first -- the one-live-session-per-proctor
    // unique index would otherwise reject the insert.
    const { data: liveSessions } = await supabase
      .from('nda_signing_sessions')
      .select('id')
      .eq('proctor_id', proctor.id)
      .in('status', ['created', 'otp_verified', 'consented', 'signing', 'signed'])

    if (liveSessions && liveSessions.length > 0) {
      const ids = liveSessions.map((s) => s.id)
      const { error: revokeError } = await supabase
        .from('nda_signing_sessions')
        .update({ status: 'revoked', revoked_at: new Date().toISOString() })
        .in('id', ids)
      if (revokeError) throw revokeError
    }

    const sessionToken = randomToken()
    const sessionTokenHash = await hashToken(sessionToken)
    const expiresAt = resolveSessionExpiry(template.expiry_policy, new Date())

    const { data: session, error: insertError } = await supabase
      .from('nda_signing_sessions')
      .insert({
        proctor_id: proctor.id,
        template_id: template.id,
        template_sha256: template.content_sha256,
        signer_name_snapshot: proctor.name || '',
        signer_email_snapshot: proctor.email,
        session_token_sha256: sessionTokenHash,
        session_expires_at: expiresAt.toISOString(),
        created_by: createdBy,
      })
      .select('id')
      .single()
    if (insertError) throw insertError

    if (liveSessions && liveSessions.length > 0) {
      const ids = liveSessions.map((s) => s.id)
      await supabase.from('nda_signing_sessions').update({ superseded_by: session.id }).in('id', ids)
      for (const s of liveSessions) {
        await logEvent(supabase, s.id, 'session_superseded', req, { superseded_by: session.id })
      }
    }

    await logEvent(supabase, session.id, 'session_created', req, { created_by: createdBy })

    const signUrl = `${siteBaseUrl(originHeader)}/nda-sign?token=${sessionToken}`
    const expiryCopy =
      template.expiry_policy === 'same_day'
        ? 'This link must be completed today, by 11:59 PM IST.'
        : 'This link expires in 24 hours.'
    const recipientName = proctor.name || 'there'

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin: 0; padding: 0; background: #ffffff; color: #1f2937; font-family: Arial, sans-serif; }
    .container { max-width: 600px; margin: 0 auto; padding: 24px; }
    .card { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
    .header { padding: 20px 24px; border-bottom: 1px solid #e5e7eb; }
    .header h1 { margin: 0; font-size: 20px; color: #111827; }
    .content { padding: 24px; line-height: 1.6; font-size: 15px; }
    .button { display: inline-block; background: #2563eb; color: #ffffff !important; padding: 12px 20px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 16px 0; }
    .link { word-break: break-all; color: #2563eb; }
    .footer { padding: 16px 24px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
    .meta { margin-top: 16px; font-size: 13px; color: #4b5563; }
    ol { padding-left: 20px; margin: 8px 0; }
    ul { padding-left: 20px; margin: 8px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header"><h1>Talview: NDA &amp; Final Onboarding Documents</h1></div>
      <div class="content">
        <p>Hello ${recipientName},</p>
        <p>This link covers two activities -- please complete both:</p>
        <ol>
          <li>Sign your NDA</li>
          <li>Upload your final onboarding documents</li>
        </ol>
        <p><a href="${signUrl}" class="button" target="_blank" rel="noopener noreferrer">Sign NDA &amp; Upload Documents</a></p>
        <p class="meta">If the button does not work, use this link:</p>
        <p><a href="${signUrl}" class="link" target="_blank" rel="noopener noreferrer">${signUrl}</a></p>
        <p class="meta">${expiryCopy} You'll verify your identity with a one-time code sent to this email address.</p>
        <p class="meta"><strong>Please keep the following ready to upload:</strong></p>
        <ul>
          <li>Resume</li>
          <li>Passport-size photo</li>
          <li>Graduation certificate</li>
          <li>Aadhaar copy</li>
          <li>PAN copy</li>
          <li>Eye test report</li>
        </ul>
        <p class="meta">Accepted formats: PDF, JPG, PNG &middot; Maximum file size: 10MB per document.</p>
      </div>
      <div class="footer">Sent automatically by Talview Proctor Portal.</div>
    </div>
  </div>
</body>
</html>`
    const emailText = `Hello ${recipientName},\n\nThis link covers two activities -- please complete both:\n1. Sign your NDA\n2. Upload your final onboarding documents\n\n${signUrl}\n\n${expiryCopy}\n\nPlease keep the following ready to upload:\n- Resume\n- Passport-size photo\n- Graduation certificate\n- Aadhaar copy\n- PAN copy\n- Eye test report\n\nAccepted formats: PDF, JPG, PNG. Maximum file size: 10MB per document.\n\nSent automatically by Talview Proctor Portal.`

    await sendMailgunEmail(proctor.email, 'Action required: sign your NDA & upload onboarding documents', emailHtml, emailText)
    await logEvent(supabase, session.id, 'link_emailed', req, {})

    const { error: updateError } = await supabase
      .from('proctors')
      .update({
        nda_status: 'NDA Pending',
        nda_triggered_at: new Date().toISOString(),
        nda_triggered_by: createdBy,
        nda_link_expires_at: expiresAt.toISOString(),
        final_form_status: 'sent',
        upd: new Date().toISOString(),
      })
      .eq('id', proctor.id)
    if (updateError) throw updateError

    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
