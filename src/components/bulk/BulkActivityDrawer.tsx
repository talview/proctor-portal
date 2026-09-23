import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Clock, RefreshCw, ChevronRight, ChevronLeft, Mail, FileText } from 'lucide-react';
import Drawer from '@/components/ui/Drawer';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import LoadingSpinner from '@/components/ui/LoadingSpinner';
import {
  listRecentBulkJobs,
  getBulkJobStatus,
  getBulkJobItems,
  retryBulkDispatch,
  type BulkDispatchJob,
  type BulkJobType,
} from '@/services/bulkDispatch';
import { showAlert } from '@/components/ui/GlobalDialog';

const JOB_TYPE_LABELS: Record<string, string> = {
  send_pre_onboarding_form: 'Send Pre-Onboarding Form',
  send_onboarding_docs: 'Send Onboarding Docs',
};

// Groups the flat job list into the two sections the drawer shows -- these are the
// only two job_types that exist (see bulk_dispatch_jobs' own CHECK constraint); no
// separate NDA job type exists (NDA rendering is a completely different job queue),
// so "Pre-Onboarding & NDA" is just send_pre_onboarding_form -- the pre-onboarding
// form send is the step that leads into NDA signing.
const JOB_GROUPS: { title: string; jobType: BulkJobType; Icon: typeof Mail }[] = [
  { title: 'Pre-Onboarding & NDA', jobType: 'send_pre_onboarding_form', Icon: Mail },
  { title: 'Onboarding Docs', jobType: 'send_onboarding_docs', Icon: FileText },
];

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
  const [typeFilter, setTypeFilter] = useState<'all' | BulkJobType>('all');

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
    const GroupIcon = JOB_GROUPS.find((g) => g.jobType === job.job_type)?.Icon || Mail;
    return (
      <div key={job.id} className="bg-surface2 border border-border rounded-lg p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <div className="text-sm font-semibold text-text">
              {JOB_TYPE_LABELS[job.job_type] || job.job_type}{' '}
              <span className="text-text3 font-normal">#{job.seq}</span>
            </div>
            <div className="text-[11px] text-text3 flex items-center gap-1.5">
              <GroupIcon className="w-3 h-3 flex-shrink-0" />
              {new Date(job.created_at).toLocaleString()} · {job.selected_count} selected
            </div>
          </div>
          <span
            className={`px-2 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap ${
              job.status !== 'completed'
                ? 'bg-warning/10 text-warning'
                : job.failed_count > 0
                ? 'bg-danger/10 text-danger'
                : 'bg-success/10 text-success'
            }`}
          >
            {job.status !== 'completed'
              ? 'Processing'
              : job.failed_count > 0
              ? `Completed · ${job.failed_count} failed`
              : 'Completed'}
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
    <Drawer isOpen={isOpen} onClose={handleClose} title="Bulk Activity">
      {!detailJobId ? (
        <div className="space-y-5">
          {/* All / Pre-Onboarding & NDA / Onboarding Docs -- filters the list down to
              one job_type instead of just labeling the two groups, for when there's
              enough of one kind that scrolling past the other gets tedious. */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {(['all', ...JOB_GROUPS.map((g) => g.jobType)] as const).map((value) => {
              const label = value === 'all' ? 'All' : JOB_GROUPS.find((g) => g.jobType === value)!.title;
              const active = typeFilter === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTypeFilter(value)}
                  className={`text-[12px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${
                    active ? 'bg-accent/10 text-accent border-transparent' : 'bg-surface border-border text-text2 hover:border-border2'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {listLoading ? (
            <div className="flex justify-center py-12">
              <LoadingSpinner size="md" />
            </div>
          ) : jobs.length === 0 ? (
            <EmptyState title="No bulk actions yet" message="Bulk sends you trigger will show up here." compact />
          ) : !jobs.some((j) => typeFilter === 'all' || j.job_type === typeFilter) ? (
            <EmptyState title="No matching activity" message="Nothing of this type yet." compact />
          ) : (
            JOB_GROUPS.filter(({ jobType }) => typeFilter === 'all' || typeFilter === jobType).map(({ title, jobType }) => {
              const groupJobs = jobs.filter((j) => j.job_type === jobType);
              if (groupJobs.length === 0) return null;
              return (
                <div key={jobType}>
                  <div className="text-[11px] font-bold text-text3 uppercase tracking-wide mb-2">{title}</div>
                  <div className="space-y-3">{groupJobs.map(renderJobRow)}</div>
                </div>
              );
            })
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
                {JOB_TYPE_LABELS[detailStatus.job.job_type] || detailStatus.job.job_type}{' '}
                <span className="text-text3 font-normal">#{detailStatus.job.seq}</span>
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
    </Drawer>
  );
}
