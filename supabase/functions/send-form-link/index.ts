// Send form link email to proctor. Thin wrapper around the shared dispatchPreOnboardingForm
// (also used by bulk-dispatch-worker for the bulk "Send Pre-Onboarding Form" action) --
// this file keeps only the HTTP/auth contract, not the dispatch logic itself.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { dispatchPreOnboardingForm } from '../_shared/dispatch.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Verify the caller is an authenticated admin/coordinator -- this function used to
    // have no auth check at all, letting anyone with the public anon key spam form-link
    // emails / rotate tokens for arbitrary proctors. Vendor was previously included here
    // too, but vendors only ever view interview selects admin has imported under them --
    // they don't add, import, or send/resend the onboarding form, so this is server-side
    // enforcement matching that, not just the frontend hiding the button.
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')
    const callerToken = authHeader.replace('Bearer ', '')
    const { data: callerData, error: callerError } = await supabaseClient.auth.getUser(callerToken)
    if (callerError || !callerData?.user) throw new Error('Invalid session')
    const { data: callerProfile, error: callerProfileError } = await supabaseClient
      .from('users')
      .select('role')
      .eq('id', callerData.user.id)
      .single()
    if (callerProfileError || !['admin', 'coordinator'].includes(callerProfile?.role)) {
      throw new Error('Not authorized')
    }

    const { proctorId } = await req.json()
    if (!proctorId) throw new Error('proctorId is required')

    const { data: proctor, error: fetchError } = await supabaseClient
      .from('proctors')
      .select('id, name, email, form_link_token')
      .eq('id', proctorId)
      .single()
    if (fetchError || !proctor) throw new Error('Proctor not found')

    const result = await dispatchPreOnboardingForm(supabaseClient, proctor, req.headers.get('origin'))
    if (!result.success) throw new Error(result.error || 'Failed to send form link')

    return new Response(
      JSON.stringify({ success: true, message: 'Form link sent successfully' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('Edge Function error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Unknown error' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
