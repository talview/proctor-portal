// Authorized access to the 'nda-signing' bucket's proctor documents (resume,
// passport photo, grad cert, aadhaar/PAN copies, eye test, and the signed NDA
// PDF) -- this bucket also holds NDA templates, signatures, and certificates,
// so its storage.objects RLS used to grant any authenticated user (any role)
// broad read+upload with no path/vendor scoping. Every real access now goes
// through here instead, where role/vendor authorization is actually enforced,
// so that broad grant can be removed (see the migration that accompanies this).
//
//   action:"view"            -- mints a short-lived signed URL for one of a
//                                proctor's document columns. admin/coordinator:
//                                any proctor. vendor: only their own vendor's.
//   action:"replace-request" -- admin-only. Mints a signed UPLOAD url at a
//                                server-chosen path, mirroring nda-session-
//                                upload-url's own request/confirm shape so the
//                                file's bytes never pass through this function.
//   action:"replace-confirm" -- admin-only. Records the new path on the
//                                proctors row and logs the audit event, once
//                                the client's PUT to the signed URL succeeded.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BUCKET = 'nda-signing'
const MAX_BYTES = 5 * 1024 * 1024 // 5MB -- generous for a scanned doc/photo, still bounded
const ALLOWED_EXTENSIONS: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
}

// The only columns this function will ever read/write -- never trust a
// caller-supplied column name directly (it's used to build the update/select
// payload), or an attacker could ask to "replace" an unrelated column like
// `role` or `vendor_verified`.
const DOC_KEYS = [
  'doc_resume',
  'doc_passport_photo',
  'doc_grad_cert',
  'doc_aadhaar_copy',
  'doc_pan_copy',
  'doc_eye_test',
  'nda_file_url',
] as const
type DocKey = (typeof DOC_KEYS)[number]

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // The caller's identity and role/vendor are always derived from their own
    // verified session -- never trusted from the request body. Same pattern
    // invite-user already uses, extended with vendor_id/vendors(name) since
    // this function also needs to scope a vendor caller to their own proctors.
    const callerToken = authHeader.replace('Bearer ', '')
    const { data: callerData, error: callerError } = await supabaseAdmin.auth.getUser(callerToken)
    if (callerError || !callerData?.user) throw new Error('Invalid session')

    const { data: callerProfile, error: callerProfileError } = await supabaseAdmin
      .from('users')
      .select('role, vendor_id, vendors(name)')
      .eq('id', callerData.user.id)
      .single()
    if (callerProfileError || !callerProfile) throw new Error('Could not resolve your profile')
    const callerRole = callerProfile.role as string
    const callerVendorName = (callerProfile as unknown as { vendors: { name: string } | null }).vendors?.name || null
    if (!['admin', 'coordinator', 'vendor'].includes(callerRole)) throw new Error('Not authorized')

    const body = await req.json()
    const { action, proctorId, docKey } = body

    if (!proctorId) throw new Error('proctorId is required')
    if (!DOC_KEYS.includes(docKey)) throw new Error('Invalid document key')

    const { data: proctor, error: proctorError } = await supabaseAdmin
      .from('proctors')
      .select(`id, name, vendor, ${DOC_KEYS.join(', ')}`)
      .eq('id', proctorId)
      .single()
    if (proctorError || !proctor) throw new Error('Proctor not found')

    // admin/coordinator: any proctor. vendor: only their own vendor's -- exact
    // mirror of the DB-level rule proctors_select RLS already enforces
    // elsewhere (proctors.vendor = current_user_vendor_name()), replicated
    // here since this call goes through the service-role client and bypasses
    // that policy entirely.
    if (callerRole === 'vendor' && (!callerVendorName || proctor.vendor !== callerVendorName)) {
      throw new Error("Not authorized to access this proctor's documents")
    }

    if (action === 'view') {
      const path = (proctor as Record<string, unknown>)[docKey as DocKey] as string | null
      if (!path) throw new Error('Document not uploaded')

      const downloadName = typeof body.downloadName === 'string' ? body.downloadName : undefined
      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(path, 300, downloadName ? { download: downloadName } : undefined)
      if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not generate a link for this file')

      return new Response(JSON.stringify({ success: true, url: data.signedUrl }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // Replace/remove are corrections to a candidate's own submitted paperwork --
    // deliberately admin-only, matching the existing UI gate (isAdmin) and the
    // proctors_admin_update RLS policy this then writes through.
    if (action === 'replace-request' || action === 'replace-confirm') {
      if (callerRole !== 'admin') throw new Error('Only admins can replace a proctor document')

      if (action === 'replace-request') {
        const ext = String(body.fileExt || '').toLowerCase().replace(/^\./, '')
        if (!ALLOWED_EXTENSIONS[ext]) throw new Error('Only PDF, JPG, and PNG files are accepted')

        const path = `proctors/${proctorId}/${docKey}-${Date.now()}.${ext}`
        const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path)
        if (error) throw error

        return new Response(JSON.stringify({ success: true, path, token: data.token, signedUrl: data.signedUrl }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        })
      }

      // replace-confirm
      const { path } = body
      if (!path || !path.startsWith(`proctors/${proctorId}/${docKey}-`)) {
        throw new Error('Path does not match this proctor/document')
      }

      const { data: listing, error: listError } = await supabaseAdmin.storage
        .from(BUCKET)
        .list(`proctors/${proctorId}`, { search: path.split('/').pop() })
      if (listError) throw listError
      const fileMeta = (listing || []).find((f) => path.endsWith(f.name))
      if (!fileMeta) throw new Error('Uploaded file not found -- please try uploading again')
      const byteSize = fileMeta.metadata?.size ?? 0
      if (byteSize === 0) throw new Error('Uploaded file is empty')
      if (byteSize > MAX_BYTES) throw new Error('File is too large (max 5MB)')

      const oldValue = (proctor as Record<string, unknown>)[docKey as DocKey] as string | null

      const { error: updateError } = await supabaseAdmin
        .from('proctors')
        .update({ [docKey]: path, upd: new Date().toISOString() })
        .eq('id', proctorId)
      if (updateError) throw updateError

      const label = docKey === 'nda_file_url' ? 'NDA File' : docKey.replace(/^doc_/, '').replace(/_/g, ' ')
      await supabaseAdmin.from('audit_log').insert({
        id: crypto.randomUUID(),
        usr: callerData.user.email,
        action: 'Document Replaced',
        target: proctor.name,
        detail: `${label}: replaced by admin${oldValue ? ' (had a prior file on record)' : ''} · by ${callerData.user.email}`,
      })

      return new Response(JSON.stringify({ success: true, path }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    throw new Error('action must be "view", "replace-request", or "replace-confirm"')
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || 'Unknown error' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
