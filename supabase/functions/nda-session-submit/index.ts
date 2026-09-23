// The two irreversible steps of the flow:
//   action:"sign"     otp_verified/consented -> signing. Logs consent + one event per
//                      field in a single batched DB call, CAS-locks the session into
//                      "signing", uploads the signature image, and queues a durable
//                      pdf_generation_jobs row (job_type:'sign_render') for
//                      nda-jobs-worker to render -- then returns immediately. "signing"
//                      already accepts document uploads too (see
//                      nda-session-upload-url), so there's no dead time even while
//                      rendering is still queued/in flight.
//   action:"finalize" signed -> completed. Checks all 6 docs are present/verified and
//                      the sign_render job is done; if not, responds fast with
//                      stillProcessing rather than blocking the request. Once ready,
//                      queues a pdf_generation_jobs row (job_type:'finalize_certificate')
//                      for the worker to build the certificate/audit page and complete
//                      the session -- also returns immediately rather than doing that
//                      PDF work inline.
// Both use a compare-and-swap status update (not read-then-check) so a double-click
// or retried request can never produce two signed artifacts for one session. Rendering
// itself lives in nda-jobs-worker (via _shared/ndaPdf.ts) -- this file only ever does
// the cheap synchronous bookkeeping and queues the heavy work.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  adminClient,
  requireStepToken,
  logEventsBatch,
  casUpdate,
  jsonResponse,
  errorResponse,
  corsHeaders,
  DOC_KINDS,
  getClientIp,
  getUserAgent,
} from '../_shared/nda.ts'

// Not a standard TS/Deno global -- injected by Supabase's edge-runtime specifically for
// this "return the response now, keep running" pattern. Used here only to fire the
// worker's HTTP kick without making the candidate wait on it -- the actual heavy work
// runs in that separate invocation, not in this one's background.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

function base64ToBytes(dataUrlOrBase64: string): Uint8Array {
  const base64 = dataUrlOrBase64.includes(',') ? dataUrlOrBase64.split(',')[1] : dataUrlOrBase64
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Fast, non-blocking kick -- fires the worker once for quick first progress. Never
 * awaited by the caller: the 1-minute cron (drain-nda-jobs-queue) is what guarantees
 * the job eventually runs even if this kick fails or the function recycles before it
 * lands. Same pattern bulk-dispatch-create already uses for its own worker. */
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

async function handleSign(supabase: ReturnType<typeof adminClient>, req: Request, body: any) {
  // 'signing' accepted as an entry state too -- see the recovery block just below
  // for why: this is what makes a stuck session recoverable at all.
  const session = await requireStepToken(supabase, body.stepToken, ['otp_verified', 'consented', 'signing', 'signed'])

  // Idempotent: if this session already finished signing (e.g. a retried request
  // after the client didn't see the response), just return success again.
  if (session.status === 'signed') {
    return jsonResponse({ success: true, alreadySigned: true })
  }

  if (!body.signatureImageBase64) throw new Error('signatureImageBase64 is required')

  if (session.status === 'signing') {
    // Recovery path for exactly the failure this guards against: a prior call
    // already won the CAS flip to 'signing' but died before the sign_render job
    // ever got created (template lookup, signature upload, or the job upsert
    // itself failed) -- with no job row to reclaim, nda-jobs-worker's stale-
    // reclaim logic has nothing to act on, and this session would otherwise be
    // stuck in 'signing' forever (retrying used to be rejected outright, since
    // 'signing' wasn't an allowed entry state above).
    const { data: existingJob } = await supabase
      .from('pdf_generation_jobs')
      .select('status')
      .eq('session_id', session.id)
      .eq('job_type', 'sign_render')
      .maybeSingle()
    if (existingJob && existingJob.status !== 'failed') {
      // The original attempt actually succeeded at queuing the job -- this is
      // just a duplicate/retried request (e.g. the client didn't see the first
      // response). Nothing to redo; a harmless extra kick in case the job is
      // still sitting queued is the only thing worth doing.
      kickNdaJobsWorker()
      return jsonResponse({ success: true })
    }
    // No job row (or a terminally failed one) -- genuinely stuck. Skip the CAS
    // step below (the session is already correctly 'signing') and fall through
    // to recreate the job from this retry's fresh signature/text values.
  } else {
    // CAS lock first, before any logging or queuing work -- exactly like the original
    // flow -- so a lost race (concurrent double-click/retry) never double-logs events for
    // the request that lost.
    const won = await casUpdate(supabase, session.id, ['otp_verified', 'consented'], 'signing')
    if (!won) {
      // Someone else's concurrent request won the race -- re-check final state.
      const { data: fresh } = await supabase
        .from('nda_signing_sessions')
        .select('status')
        .eq('id', session.id)
        .single()
      if (fresh?.status === 'signed' || fresh?.status === 'signing') {
        return jsonResponse({ success: true })
      }
      throw new Error('This session is being processed by another request. Please retry shortly.')
    }
  }

  const { data: template, error: templateError } = await supabase
    .from('nda_templates')
    .select('id, field_map')
    .eq('id', session.template_id)
    .single()
  if (templateError || !template) throw new Error('Template not found')

  // Consent (viewed + the explicit agreement) is one user action together with signing
  // -- logged every call, matching the previous nda-session-consent behavior -- plus one
  // event per template field, all in the single batched call this replaces two-plus-2N
  // sequential round-trips with.
  const textValues = (body.textValues && typeof body.textValues === 'object') ? body.textValues : {}
  const fieldEvents = (template.field_map as any[]).map((field) => ({
    eventType: 'field_signed',
    detail: { field_key: field.field_key, kind: field.kind },
  }))
  await logEventsBatch(supabase, session.id, req, [
    { eventType: 'nda_viewed', detail: { viewed_to_end: !!body.viewedToEnd } },
    { eventType: 'consent_given' },
    ...fieldEvents,
  ])

  // The signature image is small (a canvas PNG, not the multi-hundred-page template)
  // -- uploading it here, synchronously, is cheap and means the worker never needs
  // this request's in-memory data to do the actual render later.
  const signatureBytes = base64ToBytes(body.signatureImageBase64)
  const signatureStoragePath = `sessions/${session.id}/signature.png`
  const { error: sigUploadError } = await supabase.storage
    .from('nda-signing')
    .upload(signatureStoragePath, signatureBytes, { contentType: 'image/png', upsert: true })
  if (sigUploadError) throw sigUploadError

  // Captured here, not in the worker -- by the time nda-jobs-worker actually renders
  // this, the signer's original request (the only place a real IP/UA exists) is long
  // gone. Threaded through the job row so the 'signed_pdf_generated' event the worker
  // logs still gets a real IP instead of "unknown" in the audit certificate.
  const signerIp = getClientIp(req)
  const signerUserAgent = getUserAgent(req)

  // Upsert (not insert) -- a retried sign request hits the same row via the
  // (session_id, job_type) unique constraint. Every field the worker keys off is set
  // explicitly here, so a retry after a prior terminal failure starts completely
  // fresh rather than inheriting stale attempt_count/last_error/locked_at.
  const { error: jobError } = await supabase
    .from('pdf_generation_jobs')
    .upsert(
      {
        session_id: session.id,
        job_type: 'sign_render',
        status: 'queued',
        signature_storage_path: signatureStoragePath,
        text_values: textValues,
        signer_ip: signerIp,
        signer_user_agent: signerUserAgent,
        attempt_count: 0,
        last_error: null,
        next_retry_at: null,
        locked_at: null,
        started_at: null,
        completed_at: null,
      },
      { onConflict: 'session_id,job_type' }
    )
  if (jobError) throw jobError

  await supabase.rpc('ensure_nda_jobs_cron')
  kickNdaJobsWorker()

  return jsonResponse({ success: true })
}

async function handleFinalize(supabase: ReturnType<typeof adminClient>, req: Request, body: any) {
  const session = await requireStepToken(supabase, body.stepToken, ['signing', 'signed', 'completed'])

  if (session.status === 'completed') {
    return jsonResponse({ success: true, alreadyCompleted: true })
  }

  const { data: docs } = await supabase
    .from('nda_session_documents')
    .select('doc_kind, integrity_status')
    .eq('session_id', session.id)

  const uploaded = new Set((docs || []).map((d) => d.doc_kind))
  const missing = DOC_KINDS.filter((k) => !uploaded.has(k))
  if (missing.length > 0) {
    throw new Error(`Missing documents: ${missing.join(', ')}`)
  }

  const mismatched = (docs || []).filter((d) => d.integrity_status === 'mismatch').map((d) => d.doc_kind)
  if (mismatched.length > 0) {
    throw new Error(`These documents failed verification and must be re-uploaded: ${mismatched.join(', ')}`)
  }

  const stillVerifyingDocs = (docs || []).some((d) => d.integrity_status === 'pending')

  // Durability now lives in the job table, not in holding this request open -- unlike
  // the original version's inline 5-second poll loop, this responds immediately
  // either way. The client's own polling (NdaSignPage.tsx) is what waits out the
  // render/verification, at a patient cadence, not this request.
  if (session.status === 'signing' || stillVerifyingDocs) {
    if (session.render_error) throw new Error(session.render_error)
    return jsonResponse({ success: false, stillProcessing: true })
  }

  // session.status === 'signed' here, docs are all present and none mismatched/pending
  // -- ready for the certificate/audit-page job. The client's own retry loop calls
  // finalize repeatedly while waiting (NdaSignPage.tsx polls this), so a job may
  // already be queued/processing/retrying from an earlier call -- overwriting it
  // unconditionally on every call would race the worker's own concurrent update to
  // the same row (a naive upsert here vs. the worker's claim-and-process is not the
  // same synchronization the FOR UPDATE SKIP LOCKED claim RPC provides). Only create
  // a fresh job if none exists yet, or if a prior attempt already went terminally
  // 'failed' (a legitimate new attempt, e.g. after whatever caused the failure was
  // fixed) -- otherwise leave the in-flight job alone and just report still-processing.
  const { data: existingJob } = await supabase
    .from('pdf_generation_jobs')
    .select('status')
    .eq('session_id', session.id)
    .eq('job_type', 'finalize_certificate')
    .maybeSingle()

  if (!existingJob || existingJob.status === 'failed') {
    const { error: jobError } = await supabase
      .from('pdf_generation_jobs')
      .upsert(
        {
          session_id: session.id,
          job_type: 'finalize_certificate',
          status: 'queued',
          attempt_count: 0,
          last_error: null,
          next_retry_at: null,
          locked_at: null,
          started_at: null,
          completed_at: null,
        },
        { onConflict: 'session_id,job_type' }
      )
    if (jobError) throw jobError

    await supabase.rpc('ensure_nda_jobs_cron')
    kickNdaJobsWorker()
  }

  return jsonResponse({ success: false, stillProcessing: true })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    const body = await req.json()

    if (body.action === 'sign') return await handleSign(supabase, req, body)
    if (body.action === 'finalize') return await handleFinalize(supabase, req, body)
    throw new Error('action must be "sign" or "finalize"')
  } catch (error) {
    return errorResponse(error)
  }
})
