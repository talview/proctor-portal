// Drains bulk_dispatch_items with controlled concurrency. Invoked two ways:
//   - by the 1-minute cron (drain-bulk-dispatch-queue), body {} -- claims across ANY job
//   - by bulk-dispatch-create/retry's immediate EdgeRuntime.waitUntil kick, body
//     { jobId } -- claims scoped to that job first, for fast initial progress
// Neither path is awaited by the admin: this is what makes the *creating* request fast
// regardless of how many recipients were selected, and this worker keeps re-invoking
// (via the cron) until nothing is left, regardless of how large the backlog is -- no
// architecture change needed to go from ~100 to ~1000, just BATCH_SIZE/CONCURRENCY.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { adminClient, jsonResponse, errorResponse, corsHeaders } from '../_shared/nda.ts'
import { dispatchPreOnboardingForm, dispatchOnboardingDocs } from '../_shared/dispatch.ts'

const BATCH_SIZE = 50
const CONCURRENCY = 10
// Keep draining within this invocation until close to the wall-clock ceiling, then
// return -- the next cron tick (within 60s) or another immediate kick continues it.
const TIME_BUDGET_MS = 45_000

/** Dependency-free bounded-concurrency pool: at most `limit` items in flight at once.
 * `worker` must never throw -- each item's own try/catch decides its outcome, so one
 * slow/failed recipient can never stop the rest of the batch. */
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

async function processBatch(supabase: ReturnType<typeof adminClient>, jobId: string | null): Promise<number> {
  const { data: claimed, error: claimError } = await supabase.rpc('claim_bulk_dispatch_items', {
    p_job_id: jobId,
    p_limit: BATCH_SIZE,
  })
  if (claimError) throw claimError
  if (!claimed || claimed.length === 0) return 0

  const jobIds = Array.from(new Set(claimed.map((item: any) => item.job_id)))
  const { data: jobs } = await supabase.from('bulk_dispatch_jobs').select('*').in('id', jobIds)
  const jobById = new Map((jobs || []).map((j: any) => [j.id, j]))

  const proctorIds = Array.from(new Set(claimed.map((item: any) => item.proctor_id)))
  const { data: proctors } = await supabase
    .from('proctors')
    .select('id, name, email, form_link_token, demo_ready, assessment_ready, nda_status')
    .in('id', proctorIds)
  const proctorById = new Map((proctors || []).map((p: any) => [p.id, p]))

  // Fetched once for the whole batch, not per item -- every claimed item needing it
  // shares this single lookup regardless of which job it came from (there's only ever
  // one active template at a time).
  const needsTemplate = claimed.some((item: any) => jobById.get(item.job_id)?.job_type === 'send_onboarding_docs')
  let template: any = null
  if (needsTemplate) {
    const { data } = await supabase
      .from('nda_templates')
      .select('id, content_sha256, expiry_policy')
      .eq('is_active', true)
      .maybeSingle()
    template = data
  }

  await runWithConcurrency(claimed, CONCURRENCY, async (item: any) => {
    const job = jobById.get(item.job_id)
    const proctor = proctorById.get(item.proctor_id)
    if (!job || !proctor) {
      await supabase
        .from('bulk_dispatch_items')
        .update({ status: 'failed', failure_reason: 'Job or proctor no longer exists' })
        .eq('id', item.id)
      return
    }

    let result: { success: boolean; error?: string }
    if (job.job_type === 'send_pre_onboarding_form') {
      result = await dispatchPreOnboardingForm(supabase, proctor, null)
    } else if (!template) {
      result = { success: false, error: 'No active NDA template is published yet' }
    } else {
      result = await dispatchOnboardingDocs(supabase, proctor, template, job.created_by, null, null)
    }

    if (result.success) {
      await supabase.from('bulk_dispatch_items').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', item.id)
    } else {
      await supabase
        .from('bulk_dispatch_items')
        .update({ status: 'failed', failure_reason: result.error || 'Unknown error' })
        .eq('id', item.id)
    }
  })

  for (const id of jobIds) {
    const { data: justCompleted } = await supabase.rpc('recompute_bulk_job_progress', { p_job_id: id })
    if (justCompleted) {
      const job = jobById.get(id)
      const { data: finalCounts } = await supabase
        .from('bulk_dispatch_jobs')
        .select('sent_count, failed_count, skipped_count, eligible_count')
        .eq('id', id)
        .single()
      const { count: retriedCount } = await supabase
        .from('bulk_dispatch_items')
        .select('id', { count: 'exact', head: true })
        .eq('job_id', id)
        .gt('retry_count', 0)
      const actionLabel = (retriedCount || 0) > 0 ? 'Bulk Retry Completed' : 'Bulk Send Completed'
      const targetLabel = job?.job_type === 'send_pre_onboarding_form' ? 'Send Pre-Onboarding Form' : 'Send Onboarding Docs'
      await supabase.rpc('log_audit', {
        p_action: actionLabel,
        p_target: targetLabel,
        p_detail: `${finalCounts?.sent_count ?? 0} sent, ${finalCounts?.failed_count ?? 0} failed, ${finalCounts?.skipped_count ?? 0} skipped (of ${finalCounts?.eligible_count ?? 0} eligible)`,
        p_ref_id: id,
      })
    }
  }

  return claimed.length
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Called by pg_net (no user session) or our own immediate kick -- authenticated
    // with a narrow, purpose-built shared secret, not the service-role key (see
    // migration 0036's comment for why that key is deliberately not used here).
    const providedSecret = req.headers.get('X-Bulk-Worker-Secret')
    const expectedSecret = Deno.env.get('BULK_WORKER_SECRET')
    if (!expectedSecret || providedSecret !== expectedSecret) {
      throw new Error('Not authorized')
    }

    const supabase = adminClient()
    let jobId: string | null = null
    try {
      const body = await req.json()
      jobId = body?.jobId || null
    } catch {
      // Cron calls with an empty body -- draining across any job is the default.
    }

    const startedAt = Date.now()
    let totalClaimed = 0
    while (Date.now() - startedAt < TIME_BUDGET_MS) {
      const claimedThisRound = await processBatch(supabase, jobId)
      totalClaimed += claimedThisRound
      if (claimedThisRound < BATCH_SIZE) break // nothing left to claim right now
    }

    return jsonResponse({ success: true, processed: totalClaimed })
  } catch (error) {
    return errorResponse(error)
  }
})
