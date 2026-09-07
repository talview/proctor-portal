// Sends (or resends) an OTP for a signing session. Must only ever be called from an
// explicit "Send code" click on the signing page -- never auto-fired on page load,
// or email link-scanners/prefetchers would burn OTPs and log phantom events.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  adminClient,
  hashToken,
  hashOtp,
  generateOtp,
  logEvent,
  sendMailgunEmail,
  jsonResponse,
  errorResponse,
  corsHeaders,
} from '../_shared/nda.ts'

const MAX_RESENDS = 8

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    const { token } = await req.json()
    if (!token) throw new Error('token is required')

    const tokenHash = await hashToken(token)
    const { data: session, error } = await supabase
      .from('nda_signing_sessions')
      .select('id, status, session_expires_at, signer_email_snapshot, signer_name_snapshot, otp_send_count')
      .eq('session_token_sha256', tokenHash)
      .maybeSingle()
    if (error || !session) throw new Error('Invalid or expired link')
    if (new Date(session.session_expires_at) < new Date()) throw new Error('This link has expired')
    // Any non-terminal status can request a fresh code -- a returning proctor whose
    // step token expired after consenting or signing still needs to re-verify to
    // resume, not just on their very first visit.
    if (!['created', 'otp_verified', 'consented', 'signed'].includes(session.status)) {
      throw new Error('This link is no longer active')
    }
    if (session.otp_send_count >= MAX_RESENDS) {
      throw new Error('Too many code requests for this link. Contact your coordinator.')
    }

    const otp = generateOtp()
    const otpHash = await hashOtp(otp)
    const otpExpiresAt = new Date()
    otpExpiresAt.setMinutes(otpExpiresAt.getMinutes() + 10)

    const { error: updateError } = await supabase
      .from('nda_signing_sessions')
      .update({
        otp_sha256: otpHash,
        otp_expires_at: otpExpiresAt.toISOString(),
        otp_failed_attempts: 0,
        otp_send_count: session.otp_send_count + 1,
      })
      .eq('id', session.id)
    if (updateError) throw updateError

    const emailParts = session.signer_email_snapshot.split('@')
    const maskedEmail = `${emailParts[0].slice(0, 3)}***@${emailParts[1]}`
    const recipientName = session.signer_name_snapshot || 'there'

    const emailHtml = `
<!DOCTYPE html>
<html><head><style>
  body { margin:0; padding:0; background:#fff; color:#1f2937; font-family:Arial,sans-serif; }
  .container { max-width:600px; margin:0 auto; padding:24px; }
  .card { border:1px solid #e5e7eb; border-radius:8px; overflow:hidden; }
  .header { padding:20px 24px; border-bottom:1px solid #e5e7eb; }
  .header h1 { margin:0; font-size:20px; color:#111827; }
  .content { padding:24px; line-height:1.6; font-size:15px; }
  .otp-box { background:#f9fafb; border:1px solid #d1d5db; border-radius:8px; padding:18px; margin:18px 0; text-align:center; }
  .otp-code { font-size:34px; font-weight:700; letter-spacing:6px; color:#111827; font-family:'Courier New',monospace; }
  .footer { padding:16px 24px; border-top:1px solid #e5e7eb; font-size:12px; color:#6b7280; }
</style></head>
<body><div class="container"><div class="card">
  <div class="header"><h1>Talview NDA Signing Verification</h1></div>
  <div class="content">
    <p>Hello ${recipientName},</p>
    <p>Your one-time verification code for signing your NDA is:</p>
    <div class="otp-box"><div class="otp-code">${otp}</div></div>
    <p>This code expires in 10 minutes. Do not share it with anyone.</p>
  </div>
  <div class="footer">Sent automatically by Talview Proctor Portal.</div>
</div></div></body></html>`
    const emailText = `Hello ${recipientName},\n\nYour one-time verification code is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.`

    await sendMailgunEmail(session.signer_email_snapshot, 'Talview NDA signing verification code', emailHtml, emailText)
    await logEvent(supabase, session.id, 'otp_sent', req, {})

    return jsonResponse({ success: true, maskedEmail, expiresIn: 600 })
  } catch (error) {
    return errorResponse(error)
  }
})
