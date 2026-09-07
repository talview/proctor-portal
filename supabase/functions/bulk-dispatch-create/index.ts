// Creates a bulk dispatch job for either SEND_PRE_ONBOARDING_FORM or
// SEND_ONBOARDING_DOCS, validates every selected proctor server-side (the frontend
// sends its full selection, unfiltered -- this function is the eligibility authority,
// not the client), bulk-inserts the resulting job items in one round-trip, logs one
// top-level audit row, and kicks the worker once for a fast first burst of progress --
// it never waits for Mailgun, so this responds quickly regardless of how many proctors
// were selected.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { adminClient, requireAdminCaller, jsonResponse, errorResponse, corsHeaders } from '../_shared/nda.ts'

// Not a standard TS/Deno global -- see nda-session-submit for the same declaration and
// the background-tasks doc link.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

interface EligibilityResult {
  eligible: boolean
  skipReason?: string
}

function checkPreOnboardingEligibility(p: any): EligibilityResult {
  if (!p.email) return { eligible: false, skipReason: 'No email on file' }
  if (p.form_status === 'submitted') return { eligible: false, skipReason: 'Form already submitted' }
  return { eligible: true }
}

function checkOnboardingDocsEligibility(p: any): EligibilityResult {
  if (!p.email) return { eligible: false, skipReason: 'No email on file' }
  if (p.nda_status === 'NDA Signed') return { eligible: false, skipReason: 'NDA already signed' }
  if (p.demo_ready !== 'pass' || p.assessment_ready !== 'pass') {
    return { eligible: false, skipReason: 'Demo and Assessment must both pass first' }
  }
  return { eligible: true }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    const caller = await requireAdminCaller(req, supabase)

    const { action, proctorIds, idempotencyKey } = await req.json()
    if (!['SEND_PRE_ONBOARDING_FORM', 'SEND_ONBOARDING_DOCS'].includes(action)) {
      throw new Error('action must be SEND_PRE_ONBOARDING_FORM or SEND_ONBOARDING_DOCS')
    }
    if (!Array.isArray(proctorIds) || proctorIds.length === 0) throw new Error('proctorIds must be a non-empty array')
    if (!idempotencyKey) throw new Error('idempotencyKey is required')

    // A double-click/refresh/retried request with the same key returns the existing
    // job instead of creating a duplicate one.
    const { data: existingJob } = await supabase
      .from('bulk_dispatch_jobs')
      .select('id, selected_count, eligible_count, skipped_count')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle()
    if (existingJob) {
      return jsonResponse({
        jobId: existingJob.id,
        selected: existingJob.selected_count,
        eligible: existingJob.eligible_count,
        skipped: existingJob.skipped_count,
        alreadyCreated: true,
      })
    }

    const jobType = action === 'SEND_PRE_ONBOARDING_FORM' ? 'send_pre_onboarding_form' : 'send_onboarding_docs'
    const checkEligibility = action === 'SEND_PRE_ONBOARDING_FORM' ? checkPreOnboardingEligibility : checkOnboardingDocsEligibility

    // Dedupe defensively -- the frontend selection is a Set so this shouldn't happen in
    // practice, but a duplicated id would otherwise both inflate the counts and violate
    // the unique(job_id, proctor_id) constraint on insert.
    const uniqueProctorIds = Array.from(new Set(proctorIds as string[]))

    // One bulk fetch of fresh proctor rows -- the server's own eligibility check, not
    // whatever the client had cached when the selection was made.
    const { data: proctors, error: fetchError } = await supabase
      .from('proctors')
      .select('id, email, form_status, nda_status, demo_ready, assessment_ready')
      .in('id', uniqueProctorIds)
    if (fetchError) throw fetchError

    const items: { proctor_id: string; status: string; skip_reason: string | null }[] = []
    let eligibleCount = 0
    let skippedCount = 0

    for (const id of uniqueProctorIds) {
      const proctor = (proctors || []).find((p) => p.id === id)
      if (!proctor) {
        items.push({ proctor_id: id, status: 'skipped', skip_reason: 'Proctor not found' })
        skippedCount++
        continue
      }
      const result = checkEligibility(proctor)
      if (result.eligible) {
        items.push({ proctor_id: id, status: 'queued', skip_reason: null })
        eligibleCount++
      } else {
        items.push({ proctor_id: id, status: 'skipped', skip_reason: result.skipReason || 'Not eligible' })
        skippedCount++
      }
    }

    const { data: job, error: jobInsertError } = await supabase
      .from('bulk_dispatch_jobs')
      .insert({
        job_type: jobType,
        idempotency_key: idempotencyKey,
        created_by: caller.email || caller.username || caller.id,
        selected_count: uniqueProctorIds.length,
        eligible_count: eligibleCount,
        skipped_count: skippedCount,
      })
      .select('id')
      .single()
    if (jobInsertError) throw jobInsertError

    // One bulk insert for every item, regardless of N.
    const { error: itemsInsertError } = await supabase
      .from('bulk_dispatch_items')
      .insert(items.map((item) => ({ ...item, job_id: job.id })))
    if (itemsInsertError) throw itemsInsertError

    const actionLabel = action === 'SEND_PRE_ONBOARDING_FORM' ? 'Send Pre-Onboarding Form' : 'Send Onboarding Docs'
    await supabase.rpc('log_audit', {
      p_action: 'Bulk Send Initiated',
      p_target: actionLabel,
      p_detail: `${uniqueProctorIds.length} selected, ${eligibleCount} eligible and queued, ${skippedCount} skipped -- triggered by ${caller.email || caller.username || caller.id}`,
      p_ref_id: job.id,
    })

    // Edge case: if every selected proctor was skipped, the worker will never claim
    // (and therefore never recompute progress for) this job -- it would otherwise sit
    // in 'processing' forever. Recompute right away; harmless/idempotent when there is
    // real queued work too (the worker will just see it's already completed... except
    // there's nothing queued in that case, so this only ever fires for the
    // all-skipped edge case in practice).
    if (eligibleCount === 0) {
      const { data: justCompleted } = await supabase.rpc('recompute_bulk_job_progress', { p_job_id: job.id })
      if (justCompleted) {
        await supabase.rpc('log_audit', {
          p_action: 'Bulk Send Completed',
          p_target: actionLabel,
          p_detail: `0 sent, 0 failed, ${skippedCount} skipped (of 0 eligible)`,
          p_ref_id: job.id,
        })
      }
    } else {
      // Fast first burst of progress -- not awaited, and bounded by nothing the client
      // waits on. The 1-minute cron (drain-bulk-dispatch-queue) is what guarantees this
      // job eventually completes even if this kick doesn't finish it.
      const workerUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/bulk-dispatch-worker`
      const workerSecret = Deno.env.get('BULK_WORKER_SECRET') || ''
      EdgeRuntime.waitUntil(
        fetch(workerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bulk-Worker-Secret': workerSecret },
          body: JSON.stringify({ jobId: job.id }),
        }).catch((err) => console.error('Immediate worker kick failed (cron will still pick this up):', err))
      )
    }

    return jsonResponse({
      jobId: job.id,
      selected: uniqueProctorIds.length,
      eligible: eligibleCount,
      skipped: skippedCount,
    })
  } catch (error) {
    return errorResponse(error)
  }
})
