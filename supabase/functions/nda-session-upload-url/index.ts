// Two-step document upload:
//   action:"request" -> mints a single-use signed upload URL at a server-chosen,
//                        session-namespaced path (upsert:false, so a second link for
//                        the same proctor can never silently overwrite a prior one).
//   action:"confirm" -> records the nda_session_documents row immediately (using the
//                        client-computed SHA-256 the caller must send, plus a size/
//                        content-type check against storage's own object metadata --
//                        cheap, doesn't require downloading the file) and responds right
//                        away with integrity_status:'pending'. The server still never
//                        *trusts* the client's hash as final: a background task (see
//                        verifyDocumentIntegrity below, run via EdgeRuntime.waitUntil)
//                        separately downloads the object and recomputes the real SHA-256,
//                        flipping the row to 'verified' or 'mismatch'. This used to be
//                        done synchronously in "confirm" itself -- downloading the whole
//                        file just to hash it before responding -- which is exactly the
//                        blocking work this two-phase version removes from the signer's
//                        critical path while keeping the verification itself.
// The client's PUT to the signed URL happens directly against storage, never through
// this function -- keeps the function fast and avoids body-size limits on 6 files.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  adminClient,
  requireStepToken,
  logEvent,
  sha256Hex,
  jsonResponse,
  errorResponse,
  corsHeaders,
  DOC_KINDS,
} from '../_shared/nda.ts'

// Not a standard TS/Deno global -- see nda-session-submit for the same declaration and
// the background-tasks doc link.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const ALLOWED_EXTENSIONS: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
}
const MAX_BYTES = 3 * 1024 * 1024 // 3MB
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

/**
 * Downloads the object and recomputes its real SHA-256, reconciling it against what the
 * client reported at confirm time. Runs after the response has already gone out, so it
 * never blocks the signer -- failures (including a hash mismatch) are recorded on the
 * row and the audit trail rather than thrown into the void, so handleFinalize (which
 * polls for 'pending' rows) can see and act on the outcome.
 */
async function verifyDocumentIntegrity(
  supabase: ReturnType<typeof adminClient>,
  sessionId: string,
  docKind: string,
  path: string,
  clientSha256: string
) {
  try {
    const { data: fileData, error: downloadError } = await supabase.storage.from('nda-signing').download(path)
    if (downloadError || !fileData) throw new Error('Could not read the uploaded file to verify it')

    const bytes = new Uint8Array(await fileData.arrayBuffer())
    const serverSha256 = await sha256Hex(bytes)
    const matched = serverSha256 === clientSha256

    await supabase
      .from('nda_session_documents')
      .update({
        content_sha256: serverSha256,
        integrity_status: matched ? 'verified' : 'mismatch',
        verified_at: new Date().toISOString(),
      })
      .eq('session_id', sessionId)
      .eq('doc_kind', docKind)

    await logEvent(supabase, sessionId, matched ? 'document_verified' : 'document_integrity_mismatch', null, {
      doc_kind: docKind,
      client_sha256: clientSha256,
      server_sha256: serverSha256,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error verifying the uploaded document'
    console.error('verifyDocumentIntegrity failed:', error)
    try {
      // Treat an unverifiable file the same as a mismatch -- handleFinalize must never
      // wave through a document it couldn't actually confirm the contents of.
      await supabase
        .from('nda_session_documents')
        .update({ integrity_status: 'mismatch', verified_at: new Date().toISOString() })
        .eq('session_id', sessionId)
        .eq('doc_kind', docKind)
      await logEvent(supabase, sessionId, 'document_integrity_mismatch', null, { doc_kind: docKind, message })
    } catch (loggingError) {
      console.error('Failed to record document verification failure:', loggingError)
    }
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    const body = await req.json()
    const { stepToken, action, docKind } = body

    // 'signing' included so document uploads work while the signed PDF is still
    // rendering in the background (see nda-session-submit's handleSign).
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

      // Recorded immediately with the client-reported hash and integrity_status:'pending'
      // -- the row exists and the document reads as "uploaded" right away. The real
      // server-side hash is filled in moments later by the background verification below.
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
        },
        { onConflict: 'session_id,doc_kind' }
      )
      if (upsertError) throw upsertError

      await logEvent(supabase, session.id, 'document_uploaded', req, {
        doc_kind: docKind,
        client_sha256: clientSha256,
        bytes: byteSize,
      })

      EdgeRuntime.waitUntil(verifyDocumentIntegrity(supabase, session.id, docKind, path, clientSha256))

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
