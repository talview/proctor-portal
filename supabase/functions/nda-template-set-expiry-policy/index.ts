// Admin-only: change the expiry policy applied to future NDA signing sessions.
// nda_templates has no client write RLS policy (all writes are service-role, see
// migration 0012's comment), so even this one-field change needs its own function
// rather than a direct `.update()` from NdaTemplatePage.tsx.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { adminClient, requireAdminCaller, jsonResponse, errorResponse, corsHeaders } from '../_shared/nda.ts'

const VALID_POLICIES = new Set(['24h', 'same_day'])

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    await requireAdminCaller(req, supabase)

    const { expiryPolicy } = await req.json()
    if (!VALID_POLICIES.has(expiryPolicy)) {
      throw new Error(`expiryPolicy must be one of: ${Array.from(VALID_POLICIES).join(', ')}`)
    }

    const { data: template, error: findError } = await supabase
      .from('nda_templates')
      .select('id')
      .eq('is_active', true)
      .maybeSingle()
    if (findError || !template) throw new Error('No active NDA template is published yet')

    const { error: updateError } = await supabase
      .from('nda_templates')
      .update({ expiry_policy: expiryPolicy })
      .eq('id', template.id)
    if (updateError) throw updateError

    return jsonResponse({ success: true, expiryPolicy })
  } catch (error) {
    return errorResponse(error)
  }
})
