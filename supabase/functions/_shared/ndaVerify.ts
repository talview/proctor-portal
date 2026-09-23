// Per-document integrity verification, moved out of nda-session-upload-url so
// nda-jobs-worker can call it directly. Downloads the object and recomputes its real
// SHA-256, reconciling it against what the client reported at confirm time. No job-
// table bookkeeping here (status/attempt_count/locking) -- that's the worker's job.
//
// Deliberately does NOT throw when the hashes simply don't match -- a mismatch is a
// genuine, deterministic verification *result*, not an operational failure retrying
// would ever fix (the file's bytes don't change between attempts). Only a real
// problem actually doing the check (can't download the object, etc.) throws, so the
// worker can tell "this job succeeded at determining the file is bad -- mark it
// completed, not retrying" apart from "this attempt itself failed -- retry it."
import { adminClient, sha256Hex, logEvent } from './nda.ts'

export async function verifyDocumentIntegrity(
  supabase: ReturnType<typeof adminClient>,
  sessionId: string,
  docKind: string,
  path: string,
  clientSha256: string,
  jobId: string,
  uploaderIp: string | null = null,
  uploaderUserAgent: string | null = null
): Promise<{ matched: boolean; serverSha256: string; stale: boolean }> {
  const { data: fileData, error: downloadError } = await supabase.storage.from('nda-signing').download(path)
  if (downloadError || !fileData) throw new Error('Could not read the uploaded file to verify it')

  const bytes = new Uint8Array(await fileData.arrayBuffer())
  const serverSha256 = await sha256Hex(bytes)
  const matched = serverSha256 === clientSha256

  // Guarded by verifying_job_id, not just (session_id, doc_kind) -- a candidate
  // can remove() this document and confirm() a replacement while this exact
  // download/hash is still in flight (the claim RPC's row lock is released the
  // instant it returns, long before this async work finishes). remove() deletes
  // the old document_integrity_jobs row outright, so a replacement always gets a
  // fresh id (see migration 0074) -- if the document row no longer points at the
  // job THIS call was verifying, that document has already moved on and this
  // result is stale. The WHERE clause makes the write a no-op in that case
  // instead of overwriting a newer upload with a result about the old one.
  const { data: updated } = await supabase
    .from('nda_session_documents')
    .update({
      content_sha256: serverSha256,
      integrity_status: matched ? 'verified' : 'mismatch',
      verified_at: new Date().toISOString(),
    })
    .eq('session_id', sessionId)
    .eq('doc_kind', docKind)
    .eq('verifying_job_id', jobId)
    .select('session_id')

  const stale = !updated || updated.length === 0

  // Only log a verification event against the audit trail if this result was
  // actually about the document currently on file -- a stale result logging
  // "verified"/"mismatch" for a file that's no longer even the current upload
  // would itself be a misleading audit entry.
  if (!stale) {
    await logEvent(
      supabase,
      sessionId,
      matched ? 'document_verified' : 'document_integrity_mismatch',
      { ip: uploaderIp, userAgent: uploaderUserAgent },
      { doc_kind: docKind, client_sha256: clientSha256, server_sha256: serverSha256 }
    )
  }

  return { matched, serverSha256, stale }
}
