// Records that the proctor viewed the NDA and gave explicit, separate consent to sign
// it electronically. Two distinct logged events -- "viewed" is client-asserted (the
// client reports it scrolled to the end) and carries little evidentiary weight on its
// own; "consent_given" is the actual affirmative act.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { adminClient, requireStepToken, logEvent, jsonResponse, errorResponse, corsHeaders } from '../_shared/nda.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    const { stepToken, viewedToEnd } = await req.json()

    const session = await requireStepToken(supabase, stepToken, ['otp_verified', 'consented'])

    await logEvent(supabase, session.id, 'nda_viewed', req, { viewed_to_end: !!viewedToEnd })
    await logEvent(supabase, session.id, 'consent_given', req, {})

    if (session.status === 'otp_verified') {
      const { error: updateError } = await supabase
        .from('nda_signing_sessions')
        .update({ status: 'consented' })
        .eq('id', session.id)
      if (updateError) throw updateError
    }

    return jsonResponse({ success: true })
  } catch (error) {
    return errorResponse(error)
  }
})
