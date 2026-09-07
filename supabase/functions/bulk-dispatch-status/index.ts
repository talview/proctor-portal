// Read-only polling endpoint for the Bulk Activity drawer, the Audit Log's drill-down,
// and the per-row temporary "Email: Sending.../Failed" indicator. Four modes,
// dispatched by `mode` in the request body:
//   'list'                -- recent jobs (Bulk Activity drawer's list)
//   'job'                 -- one job's row + a status-group-count breakdown (compact progress view)
//   'items'               -- one job's full recipient list, joined to proctor name/email (View Details)
//   'active_for_proctors' -- processing/failed items for a set of proctors (per-row indicator)
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { adminClient, requireAdminCaller, jsonResponse, errorResponse, corsHeaders } from '../_shared/nda.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = adminClient()
    await requireAdminCaller(req, supabase)

    const body = await req.json()
    const mode = body.mode

    if (mode === 'list') {
      const { data: jobs, error } = await supabase
        .from('bulk_dispatch_jobs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(body.limit || 20)
      if (error) throw error
      return jsonResponse({ success: true, jobs: jobs || [] })
    }

    if (mode === 'job') {
      if (!body.jobId) throw new Error('jobId is required')
      const { data: job, error: jobError } = await supabase
        .from('bulk_dispatch_jobs')
        .select('*')
        .eq('id', body.jobId)
        .single()
      if (jobError || !job) throw new Error('Bulk job not found')

      const { data: items } = await supabase
        .from('bulk_dispatch_items')
        .select('status')
        .eq('job_id', body.jobId)

      const counts = { queued: 0, processing: 0, sent: 0, failed: 0, skipped: 0 }
      for (const item of items || []) {
        if (item.status in counts) (counts as any)[item.status]++
      }

      return jsonResponse({ success: true, job, counts })
    }

    if (mode === 'items') {
      if (!body.jobId) throw new Error('jobId is required')
      const { data: items, error } = await supabase
        .from('bulk_dispatch_items')
        .select('id, proctor_id, status, skip_reason, failure_reason, retry_count, sent_at, attempted_at')
        .eq('job_id', body.jobId)
        .order('created_at', { ascending: true })
      if (error) throw error

      const proctorIds = Array.from(new Set((items || []).map((i) => i.proctor_id)))
      const { data: proctors } = await supabase.from('proctors').select('id, name, email').in('id', proctorIds)
      const proctorById = new Map((proctors || []).map((p) => [p.id, p]))

      const enriched = (items || []).map((item) => ({
        ...item,
        proctorName: proctorById.get(item.proctor_id)?.name || item.proctor_id,
        proctorEmail: proctorById.get(item.proctor_id)?.email || '',
      }))

      return jsonResponse({ success: true, items: enriched })
    }

    if (mode === 'active_for_proctors') {
      const proctorIds: string[] = body.proctorIds || []
      const jobType = body.jobType
      if (proctorIds.length === 0) return jsonResponse({ success: true, items: [] })

      // Only the most recent item per proctor for this job type matters for the
      // temporary row indicator -- an old failed/sent item from a job weeks ago
      // shouldn't keep showing up next to a proctor's name forever.
      let query = supabase
        .from('bulk_dispatch_items')
        .select('proctor_id, status, failure_reason, job_id, bulk_dispatch_jobs!inner(job_type, created_at)')
        .in('proctor_id', proctorIds)
        .in('status', ['processing', 'failed'])
        .order('created_at', { ascending: false })
      if (jobType) query = query.eq('bulk_dispatch_jobs.job_type', jobType)

      const { data, error } = await query
      if (error) throw error

      const latestByProctor = new Map<string, any>()
      for (const row of data || []) {
        if (!latestByProctor.has(row.proctor_id)) latestByProctor.set(row.proctor_id, row)
      }

      return jsonResponse({ success: true, items: Array.from(latestByProctor.values()) })
    }

    throw new Error('mode must be one of: list, job, items, active_for_proctors')
  } catch (error) {
    return errorResponse(error)
  }
})
