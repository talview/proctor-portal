// Drains pdf_generation_jobs and document_integrity_jobs with controlled concurrency --
// the same pattern bulk-dispatch-worker already proves out, extended to the NDA-signing
// flow's PDF rendering and document verification, which previously ran via
// EdgeRuntime.waitUntil() (not durable: if the function instance recycled before that
// promise resolved, the work was silently abandoned).
//
// Invoked two ways: by the 1-minute cron (drain-nda-jobs-queue), body {} -- drains
// across everything due; or by nda-session-submit/nda-session-upload-url's immediate
// non-blocking kick right after queuing a job, for fast first progress.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { adminClient, jsonResponse, errorResponse, corsHeaders } from '../_shared/nda.ts'
import { renderSignedPdf, buildAndAttachCertificate } from '../_shared/ndaPdf.ts'
import { verifyDocumentIntegrity } from '../_shared/ndaVerify.ts'

const PDF_BATCH_SIZE = 10
const PDF_CONCURRENCY = 3 // CPU/memory-heavy (loads and re-saves a large PDF) -- deliberately more conservative than bulk email's concurrency of 10
const VERIFY_BATCH_SIZE = 30
const VERIFY_CONCURRENCY = 6 // I/O-bound (download + hash a small file), cheap per item
const TIME_BUDGET_MS = 45_000
const STALE_MINUTES = 5

/** Dependency-free bounded-concurrency pool -- identical shape to bulk-dispatch-
 * worker's. `worker` must never throw -- each item's own try/catch decides its
 * outcome, so one slow/failed job can never stop the rest of the batch. */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let index = 0
  async function runNext(): Promise<void> {
    const i = index++
    if (i >= items.length) return
    await worker(items[i])
    return runNext()
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()))
}

/** Exponential backoff with full jitter: base * 2^attempt, picked uniformly from
 * [0, that], capped at 5 minutes -- spreads a burst of retries out instead of having
 * them all collide again on the next fixed interval. Same shape the cron's own
 * SQL uses for the stale-reclaim path, kept in sync deliberately. */
function computeNextRetryAt(attemptCount: number): string {
  const base = 30_000
  const cap = 5 * 60_000
  const maxDelay = Math.min(cap, base * 2 ** attemptCount)
  return new Date(Date.now() + Math.random() * maxDelay).toISOString()
}

// A crashed worker can leave a job claimed ('processing') but never finished -- these
// return the rows that went terminally 'failed' (not just reclaimed to 'retrying') so
// their failure can be propagated into the columns a candidate/admin actually looks
// at, the same propagation a job hitting max_attempts during normal processing below
// already does.
async function reclaimStaleJobs(supabase: ReturnType<typeof adminClient>) {
  const { data: stalePdfJobs } = await supabase.rpc('reclaim_stale_pdf_generation_jobs', { p_stale_minutes: STALE_MINUTES })
  for (const job of stalePdfJobs || []) {
    if (job.status === 'failed') {
      await supabase.from('nda_signing_sessions').update({ render_error: job.last_error }).eq('id', job.session_id)
    }
  }

  const { data: staleVerifyJobs } = await supabase.rpc('reclaim_stale_document_integrity_jobs', { p_stale_minutes: STALE_MINUTES })
  for (const job of staleVerifyJobs || []) {
    if (job.status === 'failed') {
      // Guarded by verifying_job_id -- see ndaVerify.ts's own guard for why: a
      // stale-reclaimed job can belong to a document that's since been removed
      // and replaced, and this write must not land on the replacement's row.
      await supabase
        .from('nda_session_documents')
        .update({ integrity_status: 'mismatch', verified_at: new Date().toISOString() })
        .eq('session_id', job.session_id)
        .eq('doc_kind', job.doc_kind)
        .eq('verifying_job_id', job.id)
    }
  }
}

async function processPdfJob(supabase: ReturnType<typeof adminClient>, job: any) {
  // attempt_count increments at the start of a real processing attempt -- reclaim
  // moving a row processing->retrying/failed does NOT count as an attempt on its own.
  const currentAttempt = job.attempt_count + 1
  await supabase.from('pdf_generation_jobs').update({ attempt_count: currentAttempt }).eq('id', job.id)

  try {
    const { data: session, error: sessionError } = await supabase
      .from('nda_signing_sessions')
      .select('*')
      .eq('id', job.session_id)
      .single()
    if (sessionError || !session) throw new Error('Session not found')

    if (job.job_type === 'sign_render') {
      const { data: template, error: templateError } = await supabase
        .from('nda_templates')
        .select('*')
        .eq('id', session.template_id)
        .single()
      if (templateError || !template) throw new Error('Template not found')

      if (!job.signature_storage_path) throw new Error('Job is missing its stored signature image')
      const { data: sigFile, error: sigError } = await supabase.storage.from('nda-signing').download(job.signature_storage_path)
      if (sigError || !sigFile) throw new Error('Could not read the stored signature image')
      const signatureBytes = new Uint8Array(await sigFile.arrayBuffer())

      await renderSignedPdf(supabase, session, template, signatureBytes, job.text_values || {}, job.signer_ip, job.signer_user_agent)
    } else {
      await buildAndAttachCertificate(supabase, session)
    }

    await supabase
      .from('pdf_generation_jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), locked_at: null })
      .eq('id', job.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error rendering the PDF'
    const isTerminal = currentAttempt >= job.max_attempts
    await supabase
      .from('pdf_generation_jobs')
      .update({
        status: isTerminal ? 'failed' : 'retrying',
        last_error: message,
        next_retry_at: isTerminal ? null : computeNextRetryAt(currentAttempt),
        locked_at: null,
      })
      .eq('id', job.id)
    if (isTerminal) {
      // Reuses the column handleFinalize already checks -- no new surfacing logic
      // needed on the read side, just something that actually writes to it now.
      await supabase.from('nda_signing_sessions').update({ render_error: message }).eq('id', job.session_id)
    }
  }
}

async function processVerifyJob(supabase: ReturnType<typeof adminClient>, job: any) {
  const currentAttempt = job.attempt_count + 1
  await supabase.from('document_integrity_jobs').update({ attempt_count: currentAttempt }).eq('id', job.id)

  try {
    // A hash mismatch is a genuine, deterministic result -- verifyDocumentIntegrity
    // already records it (integrity_status:'mismatch') and does NOT throw for it, so
    // the job itself completed successfully at doing its job either way. A `stale`
    // result (the document was removed/replaced while this was in flight) is not
    // an error either -- the job still did its work correctly, its result just no
    // longer applies to anything, so this still falls through to 'completed' below.
    await verifyDocumentIntegrity(supabase, job.session_id, job.doc_kind, job.storage_path, job.client_sha256, job.id, job.uploader_ip, job.uploader_user_agent)
    await supabase
      .from('document_integrity_jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), locked_at: null })
      .eq('id', job.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error verifying the document'
    const isTerminal = currentAttempt >= job.max_attempts
    await supabase
      .from('document_integrity_jobs')
      .update({
        status: isTerminal ? 'failed' : 'retrying',
        last_error: message,
        next_retry_at: isTerminal ? null : computeNextRetryAt(currentAttempt),
        locked_at: null,
      })
      .eq('id', job.id)
    if (isTerminal) {
      // Never leave integrity_status at 'pending' forever -- treat a terminally-
      // unverifiable document exactly like a real mismatch (candidate re-uploads),
      // no new state invented. nda-session-status already surfaces this column as-is.
      // Guarded by verifying_job_id -- same staleness guard as the success path in
      // ndaVerify.ts: if the document has since been removed/replaced, this failure
      // is about a file that no longer exists and must not touch the new row.
      await supabase
        .from('nda_session_documents')
        .update({ integrity_status: 'mismatch', verified_at: new Date().toISOString() })
        .eq('session_id', job.session_id)
        .eq('doc_kind', job.doc_kind)
        .eq('verifying_job_id', job.id)
    }
  }
}

async function processBatches(supabase: ReturnType<typeof adminClient>): Promise<number> {
  const { data: pdfJobs } = await supabase.rpc('claim_pdf_generation_jobs', { p_limit: PDF_BATCH_SIZE })
  const { data: verifyJobs } = await supabase.rpc('claim_document_integrity_jobs', { p_limit: VERIFY_BATCH_SIZE })

  await Promise.all([
    runWithConcurrency(pdfJobs || [], PDF_CONCURRENCY, (job) => processPdfJob(supabase, job)),
    runWithConcurrency(verifyJobs || [], VERIFY_CONCURRENCY, (job) => processVerifyJob(supabase, job)),
  ])

  return (pdfJobs?.length || 0) + (verifyJobs?.length || 0)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Same shared-secret pattern as bulk-dispatch-worker -- called by pg_net (no user
    // session) or our own immediate kick, not by a logged-in user.
    const providedSecret = req.headers.get('X-Nda-Worker-Secret')
    const expectedSecret = Deno.env.get('NDA_WORKER_SECRET')
    if (!expectedSecret || providedSecret !== expectedSecret) {
      throw new Error('Not authorized')
    }

    const supabase = adminClient()

    await reclaimStaleJobs(supabase)

    const startedAt = Date.now()
    let totalClaimed = 0
    while (Date.now() - startedAt < TIME_BUDGET_MS) {
      const claimedThisRound = await processBatches(supabase)
      totalClaimed += claimedThisRound
      if (claimedThisRound < PDF_BATCH_SIZE + VERIFY_BATCH_SIZE) break // nothing left to claim right now
    }

    return jsonResponse({ success: true, processed: totalClaimed })
  } catch (error) {
    return errorResponse(error)
  }
})
