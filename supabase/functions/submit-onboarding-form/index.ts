// Public onboarding form final submit. Replaces the old direct anon `.update()` on
// `proctors` -- that path is now blocked by RLS entirely, and this function is the only
// way to write it, gated on the single-use token minted by verify-otp (not just an id,
// which is guessable/loggable and was the actual hole in the old design).
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { proctorId, token, formData } = await req.json()
    if (!proctorId || !token || !formData) throw new Error('proctorId, token and formData are required')

    const { name, aadhaar, phone, address, city, state, dob, gender } = formData

    if (!name || !name.trim()) throw new Error('Name is required')
    if (!aadhaar || !/^\d{12}$/.test(aadhaar)) throw new Error('Aadhaar must be 12 digits')
    if (!phone || !/^\d{10}$/.test(phone)) throw new Error('Phone must be 10 digits')
    if (!address || !address.trim()) throw new Error('Address is required')
    if (!city || !city.trim()) throw new Error('City is required')
    if (!state) throw new Error('State is required')
    if (!dob) throw new Error('Date of birth is required')
    if (!gender) throw new Error('Gender is required')

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: proctor, error: fetchError } = await supabaseAdmin
      .from('proctors')
      .select('id, form_submit_token, form_submit_token_expires_at, form_status')
      .eq('id', proctorId)
      .single()

    if (fetchError || !proctor) throw new Error('Proctor not found')
    if (!proctor.form_submit_token || proctor.form_submit_token !== token) {
      throw new Error('Invalid or already-used submission token')
    }
    if (proctor.form_submit_token_expires_at && new Date(proctor.form_submit_token_expires_at) < new Date()) {
      throw new Error('This form session has expired -- please verify OTP again')
    }
    if (proctor.form_status === 'submitted') {
      throw new Error('This form has already been submitted')
    }

    const { error: updateError } = await supabaseAdmin
      .from('proctors')
      .update({
        name: name.trim(),
        aadhaar: aadhaar.trim(),
        phone: phone.trim(),
        address: address.trim(),
        city: city.trim(),
        state,
        dob,
        gender,
        form_status: 'submitted',
        status: 'In Progress',
        stage: 1,
        // Clears the "still at Interview Selects" marker -- nothing else ever did,
        // which meant every onboarded proctor stayed permanently invisible on the
        // main Proctors page once that page started excluding this stage.
        interview_stage: '',
        form_submit_token: null,
        form_submit_token_expires_at: null,
        upd: new Date().toISOString(),
      })
      .eq('id', proctorId)

    if (updateError) throw updateError

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || 'Unknown error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
