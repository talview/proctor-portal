import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Clock, RefreshCw, ChevronRight, ChevronLeft } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import {
  listRecentBulkJobs,
  getBulkJobStatus,
  getBulkJobItems,
  retryBulkDispatch,
  type BulkDispatchJob,
} from '@/services/bulkDispatch';
import { showAlert } from '@/components/ui/GlobalDialog';

const JOB_TYPE_LABELS: Record<string, string> = {
  send_pre_onboarding_form: 'Send Pre-Onboarding Form',
  send_onboarding_docs: 'Send Onboarding Docs',
};

/** One shared drawer for inspecting bulk jobs -- opened right after starting a bulk
 * send, from a persistent "Bulk Activity" entry point on the Workforce pages, or from
 * clicking a "Bulk Send *" row in the Audit Log (via `initialJobId`). */
export default function BulkActivityDrawer({
  isOpen,
  onClose,
  initialJobId,
}: {
  isOpen: boolean;
  onClose: () => void;
  initialJobId?: string | null;
}) {
  const queryClient = useQueryClient();
  const [detailJobId, setDetailJobId] = useState<string | null>(initialJobId ?? null);

  // This component stays mounted (only `isOpen` toggles), so the useState initializer
  // above only ever runs once at first mount -- a later bulk send passing a NEW
  // initialJobId (the whole point of opening this drawer right after starting a job)
  // would otherwise be silently ignored and show stale/no detail. Re-sync whenever the
  // drawer is (re)opened with a job id to jump to.
  useEffect(() => {
    if (isOpen && initialJobId) setDetailJobId(initialJobId);
  }, [isOpen, initialJobId]);

  const { data: listData, isLoading: listLoading } = useQuery({
    queryKey: ['bulk-jobs-recent'],
    queryFn: () => listRecentBulkJobs(20),
    enabled: isOpen && !detailJobId,
    // Only poll while something's actually in flight -- no point refetching every few
    // seconds once every listed job has settled.
    refetchInterval: (query) => {
      const stillProcessing = (query.state.data?.jobs ?? []).some((j) => j.status === 'processing');
      return isOpen && !detailJobId && stillProcessing ? 4000 : false;
    },
  });
  const jobs = listData?.jobs ?? [];

  const { data: detailStatus } = useQuery({
    queryKey: ['bulk-job-status', detailJobId],
    queryFn: () => getBulkJobStatus(detailJobId!),
    enabled: isOpen && !!detailJobId,
    refetchInterval: isOpen && detailJobId ? 3000 : false,
  });

  const { data: itemsData, isLoading: itemsLoading } = useQuery({
    queryKey: ['bulk-job-items', detailJobId],
    queryFn: () => getBulkJobItems(detailJobId!),
    enabled: isOpen && !!detailJobId,
    refetchInterval: isOpen && detailJobId && detailStatus?.job.status === 'processing' ? 3000 : false,
  });

  const retryMutation = useMutation({
    mutationFn: (jobId: string) => retryBulkDispatch(jobId),
    onSuccess: (data) => {
      showAlert(data.retried > 0 ? `Retrying ${data.retried} failed recipient${data.retried === 1 ? '' : 's'}…` : 'No failed recipients to retry', {
        tone: data.retried > 0 ? 'success' : 'info',
      });
      queryClient.invalidateQueries({ queryKey: ['bulk-jobs-recent'] });
      queryClient.invalidateQueries({ queryKey: ['bulk-job-status', detailJobId] });
      queryClient.invalidateQueries({ queryKey: ['bulk-job-items', detailJobId] });
    },
    onError: (err: any) => showAlert('Retry failed: ' + err.message, { tone: 'error' }),
  });

  const handleClose = () => {
    setDetailJobId(initialJobId ?? null);
    onClose();
  };

  const renderJobRow = (job: BulkDispatchJob) => {
    const remaining = job.eligible_count - job.sent_count - job.failed_count;
    return (
      <div key={job.id} className="bg-surface2 border border-border rounded-lg p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <div className="text-sm font-semibold text-text">{JOB_TYPE_LABELS[job.job_type] || job.job_type}</div>
            <div className="text-[11px] text-text3">
              {new Date(job.created_at).toLocaleString()} · {job.selected_count} selected
            </div>
          </div>
          <span
            className={`px-2 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap ${
              job.status === 'completed' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
            }`}
          >
            {job.status === 'completed' ? 'Completed' : 'Processing'}
          </span>
        </div>
        <div className="text-xs text-text2 mb-3">
          {job.sent_count} sent
          {remaining > 0 && ` · ${remaining} processing/queued`}
          {job.failed_count > 0 && ` · ${job.failed_count} failed`}
          {job.skipped_count > 0 && ` · ${job.skipped_count} skipped`}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setDetailJobId(job.id)}>
            View Details <ChevronRight className="w-3.5 h-3.5" />
          </Button>
          {job.failed_count > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => retryMutation.mutate(job.id)}
              disabled={retryMutation.isPending}
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry Failed
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Bulk Activity" size="lg">
      {!detailJobId ? (
        <div className="space-y-3 max-h-[70vh] overflow-y-auto">
          {listLoading ? (
            <div className="flex justify-center py-12">
              <LoadingSpinner size="md" />
            </div>
          ) : jobs.length === 0 ? (
            <EmptyState title="No bulk actions yet" message="Bulk sends you trigger will show up here." compact />
          ) : (
            jobs.map(renderJobRow)
          )}
        </div>
      ) : (
        <div>
          <button
            onClick={() => setDetailJobId(null)}
            className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline mb-4"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> Back to all activity
          </button>

          {detailStatus && (
            <div className="bg-surface2 border border-border rounded-lg p-4 mb-4">
              <div className="text-sm font-semibold text-text mb-1">
                {JOB_TYPE_LABELS[detailStatus.job.job_type] || detailStatus.job.job_type}
              </div>
              <div className="text-xs text-text2 mb-3">
                {detailStatus.job.selected_count} selected · {detailStatus.job.eligible_count} eligible ·{' '}
                {detailStatus.job.skipped_count} skipped
              </div>
              <div className="flex flex-wrap gap-3 text-[11px]">
                <span className="inline-flex items-center gap-1 text-success font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> {detailStatus.counts.sent} sent
                </span>
                <span className="inline-flex items-center gap-1 text-accent font-semibold">
                  <Clock className="w-3.5 h-3.5" /> {detailStatus.counts.processing} processing
                </span>
                <span className="inline-flex items-center gap-1 text-text3 font-semibold">
                  {detailStatus.counts.queued} queued
                </span>
                <span className="inline-flex items-center gap-1 text-danger font-semibold">
                  <XCircle className="w-3.5 h-3.5" /> {detailStatus.counts.failed} failed
                </span>
              </div>
              {detailStatus.job.failed_count > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  onClick={() => retryMutation.mutate(detailStatus.job.id)}
                  disabled={retryMutation.isPending}
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Retry Failed
                </Button>
              )}
            </div>
          )}

          <div className="max-h-[45vh] overflow-y-auto border border-border rounded-lg">
            {itemsLoading ? (
              <div className="flex justify-center py-12">
                <LoadingSpinner size="md" />
              </div>
            ) : (itemsData?.items ?? []).length === 0 ? (
              <EmptyState title="No recipients" compact />
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-surface2 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-text3 uppercase text-[10px]">Proctor</th>
                    <th className="px-3 py-2 text-left font-semibold text-text3 uppercase text-[10px]">Result</th>
                    <th className="px-3 py-2 text-left font-semibold text-text3 uppercase text-[10px]">Detail</th>
                    <th className="px-3 py-2 text-left font-semibold text-text3 uppercase text-[10px]">Retries</th>
                  </tr>
                </thead>
                <tbody>
                  {(itemsData?.items ?? []).map((item) => (
                    <tr key={item.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-semibold text-text">{item.proctorName}</div>
                        <div className="text-text3">{item.proctorEmail}</div>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`font-semibold ${
                            item.status === 'sent'
                              ? 'text-success'
                              : item.status === 'failed'
                              ? 'text-danger'
                              : item.status === 'skipped'
                              ? 'text-text3'
                              : 'text-accent'
                          }`}
                        >
                          {item.status === 'sent'
                            ? 'Sent'
                            : item.status === 'failed'
                            ? 'Failed'
                            : item.status === 'skipped'
                            ? 'Skipped'
                            : item.status === 'processing'
                            ? 'Processing…'
                            : 'Queued'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-text2">
                        {item.failure_reason || item.skip_reason || (item.sent_at ? new Date(item.sent_at).toLocaleString() : '—')}
                      </td>
                      <td className="px-3 py-2 text-text2">{item.retry_count || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
