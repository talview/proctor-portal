// Verify OTP and grant access to form
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { hashOtp, constantTimeEqual, logAuditEntry } from '../_shared/nda.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const MAX_ATTEMPTS_PER_OTP = 5
const MAX_LIFETIME_ATTEMPTS = 20

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { token, otp } = await req.json()

    if (!token || !otp) {
      throw new Error('Token and OTP are required')
    }

    // Find proctor by token
    const { data: proctor, error: fetchError } = await supabaseClient
      .from('proctors')
      .select('*')
      .eq('form_link_token', token)
      .single()

    if (fetchError || !proctor) {
      throw new Error('Invalid token')
    }

    // Lifetime cap first -- never reset by a resend, unlike the per-code counter below,
    // so the total number of wrong guesses across this link's whole life is bounded
    // regardless of how many fresh codes were requested.
    if ((proctor.form_otp_failed_lifetime || 0) >= MAX_LIFETIME_ATTEMPTS) {
      throw new Error('Too many failed attempts on this link. Contact your coordinator.')
    }

    // Check if OTP exists
    if (!proctor.form_otp_hash) {
      throw new Error('No OTP found. Please request a new one.')
    }

    // Check if OTP has expired
    if (proctor.form_otp_expires_at) {
      const expiresAt = new Date(proctor.form_otp_expires_at)
      if (expiresAt < new Date()) {
        throw new Error('OTP has expired. Please request a new one.')
      }
    }

    // Check attempt limit for the current code
    if (proctor.form_otp_attempts >= MAX_ATTEMPTS_PER_OTP) {
      throw new Error('Too many failed attempts. Please request a new OTP.')
    }

    // Verify OTP -- hashed, constant-time comparison (never plaintext ===)
    const submittedHash = await hashOtp(String(otp).trim())
    if (!constantTimeEqual(submittedHash, proctor.form_otp_hash)) {
      await supabaseClient
        .from('proctors')
        .update({
          form_otp_attempts: (proctor.form_otp_attempts || 0) + 1,
          form_otp_failed_lifetime: (proctor.form_otp_failed_lifetime || 0) + 1,
          upd: new Date().toISOString(),
        })
        .eq('id', proctor.id)

      await logAuditEntry(supabaseClient, proctor.email, 'Onboarding OTP Failed', proctor.name || proctor.id, 'Incorrect code entered')

      throw new Error('Invalid OTP. Please try again.')
    }

    // OTP is valid - clear it, mint a short-lived single-use token that authorizes the
    // final form submission (replaces the old direct anon UPDATE from the client)
    const formSubmitToken = crypto.randomUUID().replace(/-/g, '')
    const tokenExpiresAt = new Date()
    tokenExpiresAt.setMinutes(tokenExpiresAt.getMinutes() + 30)

    const { error: updateError } = await supabaseClient
      .from('proctors')
      .update({
        form_otp_hash: null, // Clear OTP after successful verification
        form_otp_expires_at: null,
        form_otp_attempts: 0, // per-code counter only -- form_otp_failed_lifetime is untouched
        form_submit_token: formSubmitToken,
        form_submit_token_expires_at: tokenExpiresAt.toISOString(),
        upd: new Date().toISOString(),
      })
      .eq('id', proctor.id)

    if (updateError) {
      throw updateError
    }

    await logAuditEntry(supabaseClient, proctor.email, 'Onboarding OTP Verified', proctor.name || proctor.id, `Verified by ${proctor.email}`)

    // Return proctor data for pre-filling the form
    return new Response(
      JSON.stringify({
        success: true,
        message: 'OTP verified successfully',
        formSubmitToken,
        proctor: {
          id: proctor.id,
          email: proctor.email,
          name: proctor.name || '',
          phone: proctor.phone && !proctor.phone.startsWith('PENDING_') ? proctor.phone : '',
          // Aadhaar is stored only as a one-way hash (migration 0032) -- there's
          // nothing to pre-fill with, the candidate re-enters it if resuming.
          address: proctor.address || '',
          city: proctor.city || '',
          state: proctor.state || '',
          dob: proctor.dob || '',
          gender: proctor.gender || '',
          managed_by: proctor.managed_by,
          ptype: proctor.ptype,
        },
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
