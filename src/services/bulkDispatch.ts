import { invokeEdgeFunction } from './supabase';

export type BulkDispatchAction = 'SEND_PRE_ONBOARDING_FORM' | 'SEND_ONBOARDING_DOCS';
export type BulkJobType = 'send_pre_onboarding_form' | 'send_onboarding_docs';
export type BulkItemStatus = 'queued' | 'processing' | 'sent' | 'failed' | 'skipped';

export interface BulkDispatchJob {
  id: string;
  job_type: BulkJobType;
  status: 'processing' | 'completed';
  created_by: string;
  selected_count: number;
  eligible_count: number;
  skipped_count: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
  updated_at: string;
}

export interface BulkDispatchItem {
  id: string;
  proctor_id: string;
  status: BulkItemStatus;
  skip_reason: string | null;
  failure_reason: string | null;
  retry_count: number;
  sent_at: string | null;
  attempted_at: string | null;
  proctorName?: string;
  proctorEmail?: string;
}

export function createBulkDispatch(action: BulkDispatchAction, proctorIds: string[]) {
  const idempotencyKey = crypto.randomUUID();
  return invokeEdgeFunction<{ jobId: string; selected: number; eligible: number; skipped: number }>(
    'bulk-dispatch-create',
    { action, proctorIds, idempotencyKey }
  );
}

export function retryBulkDispatch(jobId: string) {
  return invokeEdgeFunction<{ success: boolean; retried: number; message?: string }>('bulk-dispatch-retry', { jobId });
}

export function listRecentBulkJobs(limit = 20) {
  return invokeEdgeFunction<{ jobs: BulkDispatchJob[] }>('bulk-dispatch-status', { mode: 'list', limit });
}

export function getBulkJobStatus(jobId: string) {
  return invokeEdgeFunction<{ job: BulkDispatchJob; counts: Record<BulkItemStatus, number> }>('bulk-dispatch-status', {
    mode: 'job',
    jobId,
  });
}

export function getBulkJobItems(jobId: string) {
  return invokeEdgeFunction<{ items: BulkDispatchItem[] }>('bulk-dispatch-status', { mode: 'items', jobId });
}

/** Powers the per-row temporary "Email: Sending.../Failed" indicator -- most recent
 * processing/failed dispatch item per proctor for a given job type. */
export function getActiveDispatchForProctors(proctorIds: string[], jobType: BulkJobType) {
  if (proctorIds.length === 0) return Promise.resolve({ items: [] as BulkDispatchItem[] });
  return invokeEdgeFunction<{ items: BulkDispatchItem[] }>('bulk-dispatch-status', {
    mode: 'active_for_proctors',
    proctorIds,
    jobType,
  });
}
