// Public, self-service "forgot password" -- always responds with the same
// generic message regardless of whether the email matches a real account, so
// this endpoint can't be used to enumerate which emails have accounts. Uses
// generateLink (does NOT send Supabase's own email, same reasoning as
// invite-user) + Mailgun, matching this codebase's established delivery
// pattern for every other admin/candidate-facing email.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { adminClient, sendMailgunEmail, logAuditEntry } from '../_shared/nda.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const RESET_COOLDOWN_SECONDS = 30

function genericResponse() {
  return new Response(
    JSON.stringify({ success: true, message: 'If an account exists for that email, a reset link has been sent.' }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
  )
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email } = await req.json()
    if (!email || typeof email !== 'string') {
      return genericResponse()
    }

    const supabaseAdmin = adminClient()

    const { data: profile } = await supabaseAdmin
      .from('users')
      .select('id, name, password_reset_last_sent_at')
      .eq('email', email)
      .maybeSingle()

    // Same response either way -- no account with that email, or an account
    // that exists but is already in its cooldown window, both look identical
    // to the caller.
    if (!profile) {
      return genericResponse()
    }
    if (profile.password_reset_last_sent_at) {
      const secondsSinceLastSend = (Date.now() - new Date(profile.password_reset_last_sent_at).getTime()) / 1000
      if (secondsSinceLastSend < RESET_COOLDOWN_SECONDS) {
        return genericResponse()
      }
    }

    const baseUrl = (Deno.env.get('PUBLIC_SITE_URL') || req.headers.get('origin') || 'http://localhost:3000')
      .replace(/\/$/, '')

    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: `${baseUrl}/reset-password` },
    })
    if (linkError) throw linkError

    const resetUrl = linkData.properties.action_link
    const recipientName = profile.name || 'there'

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
        <h1>Reset your Talview Proctor Portal password</h1>
      </div>
      <div class="content">
        <p>Hello ${recipientName},</p>
        <p>We received a request to reset your password. Click below to choose a new one.</p>
        <p>
          <a href="${resetUrl}" class="button" target="_blank" rel="noopener noreferrer">Reset Password</a>
        </p>
        <p class="meta">If the button does not work, use this link:</p>
        <p><a href="${resetUrl}" class="link" target="_blank" rel="noopener noreferrer">${resetUrl}</a></p>
        <p class="meta">If you didn't request this, you can safely ignore this email -- your password will not be changed.</p>
      </div>
      <div class="footer">
        Sent automatically by Talview Proctor Portal.
      </div>
    </div>
  </div>
</body>
</html>
    `
    const emailText = `Reset your Talview Proctor Portal password.

We received a request to reset your password. Use the link below to choose a new one:
${resetUrl}

If you didn't request this, you can safely ignore this email -- your password will not be changed.

Sent automatically by Talview Proctor Portal.`

    await sendMailgunEmail(email, 'Reset your Talview Proctor Portal password', emailHtml, emailText)

    await supabaseAdmin
      .from('users')
      .update({ password_reset_last_sent_at: new Date().toISOString() })
      .eq('id', profile.id)

    await logAuditEntry(supabaseAdmin, email, 'Password Reset Requested', profile.name || email, `Reset link sent to ${email}`)

    return genericResponse()
  } catch {
    // Never surface the real error -- same generic response either way, so a
    // Mailgun outage or a malformed request can't be distinguished from "no
    // account with that email" by anyone probing this endpoint.
    return genericResponse()
  }
})
