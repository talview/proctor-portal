// "Retry Failed" -- resets only a job's failed items back to queued and kicks the
// worker once, immediately. Never touches sent/skipped items.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { adminClient, requireAdminCaller, jsonResponse, errorResponse, corsHeaders } from '../_shared/nda.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    const caller = await requireAdminCaller(req, supabase)

    const { jobId } = await req.json()
    if (!jobId) throw new Error('jobId is required')

    const { data: job, error: jobError } = await supabase
      .from('bulk_dispatch_jobs')
      .select('id, job_type')
      .eq('id', jobId)
      .single()
    if (jobError || !job) throw new Error('Bulk job not found')

    const { data: retriedCount, error: retryError } = await supabase.rpc('retry_failed_bulk_dispatch_items', {
      p_job_id: jobId,
    })
    if (retryError) throw retryError

    if (!retriedCount || retriedCount === 0) {
      return jsonResponse({ success: true, retried: 0, message: 'No failed recipients to retry' })
    }

    const targetLabel = job.job_type === 'send_pre_onboarding_form' ? 'Send Pre-Onboarding Form' : 'Send Onboarding Docs'
    await supabase.rpc('log_audit', {
      p_action: 'Bulk Retry Triggered',
      p_target: targetLabel,
      p_detail: `${retriedCount} failed recipient${retriedCount === 1 ? '' : 's'} re-queued by ${caller.email || caller.username || caller.id}`,
      p_ref_id: jobId,
    })

    const workerUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/bulk-dispatch-worker`
    const workerSecret = Deno.env.get('BULK_WORKER_SECRET') || ''
    EdgeRuntime.waitUntil(
      fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bulk-Worker-Secret': workerSecret },
        body: JSON.stringify({ jobId }),
      }).catch((err) => console.error('Immediate worker kick failed (cron will still pick this up):', err))
    )

    return jsonResponse({ success: true, retried: retriedCount })
  } catch (error) {
    return errorResponse(error)
  }
})
