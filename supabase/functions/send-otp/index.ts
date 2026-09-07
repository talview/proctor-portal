// Generate and send OTP for form access
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { generateOtp, hashOtp, logAuditEntry, sendMailgunEmail } from '../_shared/nda.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const MAX_RESENDS = 8

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { token } = await req.json()

    if (!token) {
      throw new Error('Token is required')
    }

    // Find proctor by token
    const { data: proctor, error: fetchError } = await supabaseClient
      .from('proctors')
      .select('*')
      .eq('form_link_token', token)
      .single()

    if (fetchError || !proctor) {
      throw new Error('Invalid or expired token')
    }

    // Check if link has expired
    if (proctor.form_link_expires_at) {
      const expiresAt = new Date(proctor.form_link_expires_at)
      if (expiresAt < new Date()) {
        throw new Error('Form link has expired')
      }
    }

    // Check if already submitted
    if (proctor.form_status === 'submitted') {
      throw new Error('Form has already been submitted')
    }

    // Caps how many fresh codes can ever be requested for this link -- without this,
    // resetting the per-code attempt counter on every resend (below) gave an
    // unlimited total guess budget, just five guesses at a time.
    if ((proctor.form_otp_send_count || 0) >= MAX_RESENDS) {
      throw new Error('Too many code requests for this link. Contact your coordinator.')
    }

    // Generate new OTP -- crypto.getRandomValues-based (not Math.random()), stored
    // hashed (not plaintext), matching the NDA signing OTP's already-reviewed design.
    const otp = generateOtp()
    const otpHash = await hashOtp(otp)
    const otpExpiresAt = new Date()
    otpExpiresAt.setMinutes(otpExpiresAt.getMinutes() + 10) // 10 minutes validity

    // Update proctor with OTP
    const { error: updateError } = await supabaseClient
      .from('proctors')
      .update({
        form_otp_hash: otpHash,
        form_otp_expires_at: otpExpiresAt.toISOString(),
        form_otp_attempts: 0, // per-code attempts -- fine to reset, the code itself just changed
        form_otp_send_count: (proctor.form_otp_send_count || 0) + 1, // lifetime -- never reset
        form_access_count: (proctor.form_access_count || 0) + 1,
        upd: new Date().toISOString(),
      })
      .eq('id', proctor.id)

    if (updateError) {
      throw updateError
    }

    await logAuditEntry(supabaseClient, proctor.email, 'Onboarding OTP Sent', proctor.name || proctor.id, `Code sent to ${proctor.email}`)

    // Mask email for display
    const emailParts = proctor.email.split('@')
    const maskedEmail = `${emailParts[0].slice(0, 3)}***@${emailParts[1]}`
    const recipientName = proctor.name || 'there'

    // Send OTP email
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
    .otp-box { background: #f9fafb; border: 1px solid #d1d5db; border-radius: 8px; padding: 18px; margin: 18px 0; text-align: center; }
    .otp-code { font-size: 34px; font-weight: 700; letter-spacing: 6px; color: #111827; font-family: 'Courier New', monospace; }
    .footer { padding: 16px 24px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
    .meta { margin-top: 16px; font-size: 13px; color: #4b5563; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <h1>Talview Verification Code</h1>
      </div>
      <div class="content">
        <p>Hello ${recipientName},</p>
        <p>Your one-time verification code is:</p>
        <div class="otp-box">
          <div class="otp-code">${otp}</div>
        </div>
        <p class="meta">
          This code expires in 10 minutes. Do not share it with anyone.
        </p>
        <p class="meta">
          If you did not request this code, you can ignore this message.
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

    // Send via the shared Mailgun helper -- this used to hand-roll its own fetch call
    // to Mailgun here (duplicating _shared/nda.ts's sendMailgunEmail) and swallowed
    // Mailgun's real rejection reason into a fixed "Failed to send OTP email" string, so
    // a real cause (a send-limit, an invalid recipient) never reached the candidate/admin.
    const emailText = `Hello ${recipientName},

Your one-time verification code is: ${otp}

This code expires in 10 minutes. Do not share it with anyone.
If you did not request this code, you can ignore this message.

Sent automatically by Talview Proctor Portal.`

    await sendMailgunEmail(proctor.email, 'Talview verification code', emailHtml, emailText)

    return new Response(
      JSON.stringify({
        success: true,
        message: 'OTP sent successfully',
        maskedEmail,
        expiresIn: 600, // seconds
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      }
    )
  }
})
