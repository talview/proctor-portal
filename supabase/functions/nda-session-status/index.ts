// Lets the signing page resume exactly where a proctor left off (e.g. they signed the
// NDA, closed the tab, and came back later) without ever re-collecting a signature
// already given. Accepts either the long-lived session token (start of the flow) or
// the short-lived step token (mid-flow), whichever the page currently holds.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { adminClient, hashToken, jsonResponse, errorResponse, corsHeaders, DOC_KINDS } from '../_shared/nda.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    const { token, stepToken } = await req.json()
    if (!token && !stepToken) throw new Error('token or stepToken is required')

    let session
    let stepTokenIsValid = false
    if (stepToken) {
      const stepTokenHash = await hashToken(stepToken)
      const { data } = await supabase
        .from('nda_signing_sessions')
        .select('id, status, session_expires_at, step_token_expires_at, template_id, signer_name_snapshot')
        .eq('step_token_sha256', stepTokenHash)
        .maybeSingle()
      session = data
      stepTokenIsValid = !!data?.step_token_expires_at && new Date(data.step_token_expires_at) > new Date()
    } else {
      const tokenHash = await hashToken(token)
      const { data } = await supabase
        .from('nda_signing_sessions')
        .select('id, status, session_expires_at, step_token_expires_at, template_id, signer_name_snapshot')
        .eq('session_token_sha256', tokenHash)
        .maybeSingle()
      session = data
    }

    if (!session) throw new Error('Invalid or expired link')
    if (new Date(session.session_expires_at) < new Date()) {
      return jsonResponse({ success: true, status: 'expired', uploadedDocKinds: [] })
    }

    const { data: docs } = await supabase
      .from('nda_session_documents')
      .select('doc_kind, storage_path, byte_size, integrity_status')
      .eq('session_id', session.id)

    const response: Record<string, unknown> = {
      success: true,
      status: session.status,
      signerName: session.signer_name_snapshot,
      uploadedDocKinds: (docs || []).map((d) => d.doc_kind),
      uploadedDocs: (docs || []).map((d) => ({
        docKind: d.doc_kind,
        fileName: d.storage_path.split('/').pop(),
        byteSize: d.byte_size,
        integrityStatus: d.integrity_status,
      })),
      allDocKinds: DOC_KINDS,
      stepTokenValid: stepTokenIsValid,
    }

    // Only hand over template details (field positions, a signed PDF URL) once
    // identity has been verified -- never to a request holding only the long-lived
    // session token.
    if (stepTokenIsValid) {
      const { data: template } = await supabase
        .from('nda_templates')
        .select('storage_bucket, storage_path, field_map, page_count')
        .eq('id', session.template_id)
        .single()

      if (template) {
        const { data: signedUrlData } = await supabase.storage
          .from(template.storage_bucket)
          .createSignedUrl(template.storage_path, 600)

        response.templateFieldMap = template.field_map
        response.templatePageCount = template.page_count
        response.templatePdfUrl = signedUrlData?.signedUrl || null
      }
    }

    return jsonResponse(response)
  } catch (error) {
    return errorResponse(error)
  }
})
