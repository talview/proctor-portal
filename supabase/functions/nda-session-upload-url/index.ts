// Two-step document upload:
//   action:"request" -> mints a single-use signed upload URL at a server-chosen,
//                        session-namespaced path (upsert:false, so a second link for
//                        the same proctor can never silently overwrite a prior one).
//   action:"confirm" -> records the nda_session_documents row immediately (using the
//                        client-computed SHA-256 the caller must send, plus a size/
//                        content-type check against storage's own object metadata --
//                        cheap, doesn't require downloading the file) and responds right
//                        away with integrity_status:'pending'. The server still never
//                        *trusts* the client's hash as final: a durable
//                        document_integrity_jobs row is queued for nda-jobs-worker,
//                        which separately downloads the object and recomputes the real
//                        SHA-256, flipping nda_session_documents to 'verified' or
//                        'mismatch'. This used to run via EdgeRuntime.waitUntil, which
//                        isn't durable -- if the function instance recycled before that
//                        background promise resolved, the verification was silently
//                        abandoned and the document stayed 'pending' forever with no
//                        error shown to anyone.
// The client's PUT to the signed URL happens directly against storage, never through
// this function -- keeps the function fast and avoids body-size limits on 6 files.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  adminClient,
  requireStepToken,
  logEvent,
  jsonResponse,
  errorResponse,
  corsHeaders,
  DOC_KINDS,
  getClientIp,
  getUserAgent,
} from '../_shared/nda.ts'

// Not a standard TS/Deno global -- see nda-session-submit for the same declaration and
// usage: only fires the worker's HTTP kick, the actual verification work runs in that
// separate invocation.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const ALLOWED_EXTENSIONS: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
}
const MAX_BYTES = 3 * 1024 * 1024 // 3MB
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

function kickNdaJobsWorker() {
  const workerUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/nda-jobs-worker`
  const workerSecret = Deno.env.get('NDA_WORKER_SECRET') || ''
  EdgeRuntime.waitUntil(
    fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Nda-Worker-Secret': workerSecret },
      body: '{}',
    }).catch((err) => console.error('Immediate NDA worker kick failed (cron will still pick this up):', err))
  )
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    const body = await req.json()
    const { stepToken, action, docKind } = body

    // 'signing' included so document uploads work while the signed PDF is still
    // rendering (see nda-session-submit's handleSign).
    const session = await requireStepToken(supabase, stepToken, ['consented', 'signing', 'signed'])

    if (!DOC_KINDS.includes(docKind)) throw new Error(`Invalid document kind: ${docKind}`)

    if (action === 'request') {
      const ext = String(body.fileExt || '').toLowerCase().replace(/^\./, '')
      if (!ALLOWED_EXTENSIONS[ext]) throw new Error('Only PDF, JPG, and PNG files are accepted')

      const path = `sessions/${session.id}/docs/${docKind}.${ext}`
      const { data, error } = await supabase.storage
        .from('nda-signing')
        .createSignedUploadUrl(path)
      if (error) throw error

      return jsonResponse({ success: true, path, token: data.token, signedUrl: data.signedUrl })
    }

    if (action === 'confirm') {
      const { path, clientSha256 } = body
      if (!path || !path.startsWith(`sessions/${session.id}/docs/${docKind}.`)) {
        throw new Error('Path does not match this session/document')
      }
      if (!clientSha256 || !SHA256_HEX_RE.test(clientSha256)) {
        throw new Error('A valid file hash is required')
      }

      // Object metadata (size/content-type) via list(), not a full download -- this is
      // the piece that used to require pulling the entire file into memory just to
      // learn its size before hashing it. list() on the parent "folder" with a name
      // filter is a single lightweight metadata lookup.
      const dir = path.slice(0, path.lastIndexOf('/'))
      const filename = path.slice(path.lastIndexOf('/') + 1)
      const { data: listing, error: listError } = await supabase.storage.from('nda-signing').list(dir, { search: filename })
      if (listError) throw listError
      const fileMeta = (listing || []).find((f) => f.name === filename)
      if (!fileMeta) throw new Error('Uploaded file not found -- please try uploading again')

      const byteSize = fileMeta.metadata?.size ?? 0
      if (byteSize === 0) throw new Error('Uploaded file is empty')
      if (byteSize > MAX_BYTES) throw new Error('File is too large (max 3MB)')

      const ext = filename.split('.').pop()?.toLowerCase() || ''
      const contentType = fileMeta.metadata?.mimetype || ALLOWED_EXTENSIONS[ext] || 'application/octet-stream'

      // Captured here, not in the worker -- by the time nda-jobs-worker actually
      // verifies this, the uploader's original request (the only place a real IP/UA
      // exists) is long gone. Threaded through the job row so the 'document_verified'/
      // 'document_integrity_mismatch' event the worker logs still gets a real IP
      // instead of "unknown" in the audit certificate.
      const uploaderIp = getClientIp(req)
      const uploaderUserAgent = getUserAgent(req)

      // Job row created FIRST, not the document row -- its id is threaded onto
      // nda_session_documents.verifying_job_id below so every later verification
      // write (ndaVerify.ts, nda-jobs-worker's terminal-failure/stale-reclaim
      // paths) can confirm it's still writing about the CURRENT upload generation
      // before touching the document row, not a stale one still mid-flight from a
      // just-removed/replaced document (see migration 0074). Upsert, not insert --
      // a document replaced after a prior failed/completed verification (without
      // going through remove() first) must start completely fresh; every job-state
      // field is reset explicitly here, or a stale last_error/completed_at/
      // locked_at from the old file would linger and confuse the worker or the
      // admin view. remove() deletes this row outright (not a reset), so the
      // common replace flow hits the INSERT branch here and gets a brand-new id
      // regardless -- the upsert only matters for a same-generation retry.
      const { data: jobRow, error: jobError } = await supabase
        .from('document_integrity_jobs')
        .upsert(
          {
            session_id: session.id,
            doc_kind: docKind,
            storage_path: path,
            client_sha256: clientSha256,
            uploader_ip: uploaderIp,
            uploader_user_agent: uploaderUserAgent,
            status: 'queued',
            attempt_count: 0,
            last_error: null,
            next_retry_at: null,
            locked_at: null,
            completed_at: null,
          },
          { onConflict: 'session_id,doc_kind' }
        )
        .select('id')
        .single()
      if (jobError) throw jobError

      // Recorded immediately with the client-reported hash and integrity_status:'pending'
      // -- the row exists and the document reads as "uploaded" right away. The real
      // server-side hash is filled in moments later by nda-jobs-worker.
      const { error: upsertError } = await supabase.from('nda_session_documents').upsert(
        {
          session_id: session.id,
          doc_kind: docKind,
          storage_path: path,
          client_sha256: clientSha256,
          content_sha256: null,
          integrity_status: 'pending',
          verified_at: null,
          byte_size: byteSize,
          content_type: contentType,
          verifying_job_id: jobRow.id,
        },
        { onConflict: 'session_id,doc_kind' }
      )
      if (upsertError) throw upsertError

      await logEvent(supabase, session.id, 'document_uploaded', req, {
        doc_kind: docKind,
        client_sha256: clientSha256,
        bytes: byteSize,
      })

      await supabase.rpc('ensure_nda_jobs_cron')
      kickNdaJobsWorker()

      return jsonResponse({ success: true, integrityStatus: 'pending' })
    }

    if (action === 'remove') {
      const { data: existing, error: fetchError } = await supabase
        .from('nda_session_documents')
        .select('storage_path')
        .eq('session_id', session.id)
        .eq('doc_kind', docKind)
        .maybeSingle()
      if (fetchError) throw fetchError
      if (!existing) return jsonResponse({ success: true }) // already removed/never uploaded

      await supabase.storage.from('nda-signing').remove([existing.storage_path])

      const { error: deleteError } = await supabase
        .from('nda_session_documents')
        .delete()
        .eq('session_id', session.id)
        .eq('doc_kind', docKind)
      if (deleteError) throw deleteError

      // Any queued/in-flight verification job for the just-deleted file is now stale --
      // remove it rather than leaving the worker to eventually try (and fail) to
      // download a path that no longer exists.
      await supabase.from('document_integrity_jobs').delete().eq('session_id', session.id).eq('doc_kind', docKind)

      await logEvent(supabase, session.id, 'document_removed', req, { doc_kind: docKind })

      return jsonResponse({ success: true })
    }

    if (action === 'preview') {
      const { data: existing, error: fetchError } = await supabase
        .from('nda_session_documents')
        .select('storage_path')
        .eq('session_id', session.id)
        .eq('doc_kind', docKind)
        .maybeSingle()
      if (fetchError) throw fetchError
      if (!existing) throw new Error('This document has not been uploaded yet')

      const { data: signedUrlData, error: signError } = await supabase.storage
        .from('nda-signing')
        .createSignedUrl(existing.storage_path, 300)
      if (signError || !signedUrlData) throw new Error('Could not generate a preview link')

      return jsonResponse({ success: true, url: signedUrlData.signedUrl })
    }

    throw new Error('action must be "request", "confirm", "remove", or "preview"')
  } catch (error) {
    return errorResponse(error)
  }
})
