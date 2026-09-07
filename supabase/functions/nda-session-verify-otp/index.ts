// Verifies the OTP for a signing session and mints a short-lived step token that
// authorizes the remaining steps (consent, signing, uploads, submit).
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  adminClient,
  hashToken,
  hashOtp,
  randomToken,
  constantTimeEqual,
  logEvent,
  jsonResponse,
  errorResponse,
  corsHeaders,
} from '../_shared/nda.ts'

const MAX_ATTEMPTS_PER_OTP = 5
const MAX_LIFETIME_ATTEMPTS = 20

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    const { token, otp } = await req.json()
    if (!token || !otp) throw new Error('token and otp are required')

    const tokenHash = await hashToken(token)
    const { data: session, error } = await supabase
      .from('nda_signing_sessions')
      .select('id, status, session_expires_at, otp_sha256, otp_expires_at, otp_failed_attempts, otp_failed_lifetime')
      .eq('session_token_sha256', tokenHash)
      .maybeSingle()
    if (error || !session) throw new Error('Invalid or expired link')
    if (new Date(session.session_expires_at) < new Date()) throw new Error('This link has expired')
    // Widened for resumability: a returning proctor re-verifying to refresh an
    // expired step token after already consenting/signing must still be allowed through.
    if (!['created', 'otp_verified', 'consented', 'signed'].includes(session.status)) {
      throw new Error('This link is no longer active')
    }

    if (session.otp_failed_lifetime >= MAX_LIFETIME_ATTEMPTS) {
      throw new Error('Too many failed attempts on this link. Contact your coordinator.')
    }
    if (!session.otp_sha256) throw new Error('No code has been sent yet. Request a new one.')
    if (session.otp_expires_at && new Date(session.otp_expires_at) < new Date()) {
      throw new Error('This code has expired. Request a new one.')
    }
    if (session.otp_failed_attempts >= MAX_ATTEMPTS_PER_OTP) {
      throw new Error('Too many failed attempts for this code. Request a new one.')
    }

    const submittedHash = await hashOtp(String(otp).trim())
    if (!constantTimeEqual(submittedHash, session.otp_sha256)) {
      await supabase
        .from('nda_signing_sessions')
        .update({
          otp_failed_attempts: session.otp_failed_attempts + 1,
          otp_failed_lifetime: session.otp_failed_lifetime + 1,
        })
        .eq('id', session.id)
      await logEvent(supabase, session.id, 'otp_failed', req, {})
      throw new Error('Incorrect code. Please try again.')
    }

    const stepToken = randomToken()
    const stepTokenHash = await hashToken(stepToken)
    const stepExpiresAt = new Date()
    stepExpiresAt.setMinutes(stepExpiresAt.getMinutes() + 45)

    const { error: updateError } = await supabase
      .from('nda_signing_sessions')
      .update({
        otp_sha256: null,
        otp_expires_at: null,
        otp_failed_attempts: 0,
        status: session.status === 'created' ? 'otp_verified' : session.status,
        step_token_sha256: stepTokenHash,
        step_token_expires_at: stepExpiresAt.toISOString(),
      })
      .eq('id', session.id)
    if (updateError) throw updateError

    await logEvent(supabase, session.id, 'otp_verified', req, {})

    return jsonResponse({ success: true, stepToken, expiresIn: 2700 })
  } catch (error) {
    return errorResponse(error)
  }
})
