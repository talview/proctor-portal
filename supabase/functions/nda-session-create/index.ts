// Admin-triggered: "Send Onboarding Docs" / "Resend Docs". Thin wrapper around the
// shared dispatchOnboardingDocs (also used by bulk-dispatch-worker for the bulk
// "Send Onboarding Docs" action) -- this file keeps only the HTTP/auth contract and the
// active-template lookup, not the dispatch logic itself.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { adminClient, requireAdminCaller, jsonResponse, errorResponse, corsHeaders } from '../_shared/nda.ts'
import { dispatchOnboardingDocs } from '../_shared/dispatch.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    const caller = await requireAdminCaller(req, supabase)

    const { proctorId } = await req.json()
    if (!proctorId) throw new Error('proctorId is required')

    const { data: proctor, error: proctorError } = await supabase
      .from('proctors')
      .select('id, name, email, demo_ready, assessment_ready')
      .eq('id', proctorId)
      .single()
    if (proctorError || !proctor) throw new Error('Proctor not found')

    const { data: template, error: templateError } = await supabase
      .from('nda_templates')
      .select('id, content_sha256, expiry_policy')
      .eq('is_active', true)
      .maybeSingle()
    if (templateError || !template) throw new Error('No active NDA template is published yet')

    const createdBy = caller.email || caller.username || caller.id
    const result = await dispatchOnboardingDocs(supabase, proctor, template, createdBy, req.headers.get('origin'), req)
    if (!result.success) throw new Error(result.error || 'Failed to send onboarding docs')

    return jsonResponse({ success: true })
  } catch (error) {
    return errorResponse(error)
  }
})
