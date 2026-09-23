import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import { localDateString } from '@/utils/formatters';
import { listRecentBulkJobs } from '@/services/bulkDispatch';

export interface EvalReminderBucket {
  kind: 'eval';
  sortKey: number;
  date: string;
  evalType: 'demo' | 'assessment';
  count: number;
}
export interface NdaReminderItem {
  kind: 'nda';
  sortKey: number;
  proctor: { id: string; name: string; vendor: string | null; nda_link_expires_at: string };
}
export type ReminderItem = EvalReminderBucket | NdaReminderItem;

export function urgencyBadge(dateStr: string, today: string): { label: string; tone: 'danger' | 'warning' } {
  if (dateStr === today) return { label: 'Today', tone: 'warning' };
  const days = Math.round((new Date(today).getTime() - new Date(dateStr).getTime()) / 86_400_000);
  return { label: `${days}d overdue`, tone: 'danger' };
}

export function ndaBadge(expiresAt: string): { label: string; tone: 'danger' | 'warning' } {
  const diffDays = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (diffDays <= 0) return { label: diffDays === 0 ? 'Expires today' : `Expired ${Math.abs(diffDays)}d ago`, tone: 'danger' };
  return { label: `Expires in ${diffDays}d`, tone: 'warning' };
}

export function reminderBadge(item: ReminderItem, today: string): { label: string; tone: 'danger' | 'warning' } {
  return item.kind === 'eval' ? urgencyBadge(item.date, today) : ndaBadge(item.proctor.nda_link_expires_at);
}

export function formatReminderDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Shared title copy -- used verbatim by both WorkspacePage's Upcoming Tasks cards
 * and NotificationBell's dropdown, so the two surfaces never disagree on wording. */
export function reminderTitle(item: ReminderItem): string {
  if (item.kind === 'eval') {
    const kindLabel = item.evalType === 'demo' ? 'demos' : 'assessments';
    return `${item.count} pending ${kindLabel} from ${formatReminderDate(item.date)}`;
  }
  return `NDA link expiring — ${item.proctor.name}`;
}

export function reminderDescription(item: ReminderItem): string {
  return item.kind === 'eval' ? 'View in Scheduled Events' : `${item.proctor.vendor || 'No vendor'} · consider a resend`;
}

/** Everything "needs attention right now" across the app -- shared by Workspace's
 * Upcoming Tasks panel and the topbar's notification bell, so building a second
 * consumer never means a second, potentially-drifting query. Demo/assessment
 * results overdue or due today are bucketed by (type, date) rather than one item
 * per evaluation -- "12 demos are pending from the 12th" is what's actionable,
 * not 12 near-identical rows. NDA links about to expire stay one item per proctor
 * (each needs its own resend action). BGV is deliberately excluded (out of scope
 * for this reminder space). */
export function useUpcomingReminders() {
  const { user } = useAuthStore();
  const today = localDateString();

  const { data: dueEvaluations = [], isLoading: evalsLoading } = useQuery({
    queryKey: ['workspace-upcoming-evals', user?.username, today],
    queryFn: async () => {
      let query = supabase
        .from('proctor_evaluations')
        .select('id, eval_type, panel_user, scheduled_date')
        .is('result', null)
        .lte('scheduled_date', today)
        .order('scheduled_date', { ascending: true });
      if (user?.role !== 'admin') query = query.eq('panel_user', user?.username);
      const { data, error } = await query;
      if (error) throw error;
      return data as { id: string; eval_type: 'demo' | 'assessment'; panel_user: string; scheduled_date: string }[];
    },
  });

  // NDA dispatch/resend is an admin-only action on the Proctors page -- a
  // coordinator following this reminder to that record couldn't act on it anyway,
  // so this query (and the reminder type it drives) is admin-only.
  const { data: expiringNda = [], isLoading: ndaLoading } = useQuery({
    queryKey: ['workspace-upcoming-nda'],
    queryFn: async () => {
      const soon = new Date();
      soon.setDate(soon.getDate() + 3);
      const { data, error } = await supabase
        .from('proctors')
        .select('id, name, vendor, nda_link_expires_at')
        .eq('nda_status', 'NDA Pending')
        .not('nda_link_expires_at', 'is', null)
        .lte('nda_link_expires_at', soon.toISOString())
        .order('nda_link_expires_at', { ascending: true });
      if (error) throw error;
      return data as { id: string; name: string; vendor: string | null; nda_link_expires_at: string }[];
    },
    enabled: user?.role === 'admin',
  });

  const buckets = new Map<string, EvalReminderBucket>();
  for (const ev of dueEvaluations) {
    const key = `${ev.eval_type}|${ev.scheduled_date}`;
    const existing = buckets.get(key);
    if (existing) existing.count += 1;
    else buckets.set(key, { kind: 'eval', sortKey: new Date(ev.scheduled_date).getTime(), date: ev.scheduled_date, evalType: ev.eval_type, count: 1 });
  }

  const items: ReminderItem[] = [
    ...buckets.values(),
    ...expiringNda.map((p): NdaReminderItem => ({ kind: 'nda', sortKey: new Date(p.nda_link_expires_at).getTime(), proctor: p })),
  ].sort((a, b) => a.sortKey - b.sortKey);

  return { items, today, isLoading: evalsLoading || ndaLoading };
}

export interface BulkFailureAlert {
  kind: 'bulk_failure';
  sortKey: number;
  jobId: string;
  seq: number;
  failedCount: number;
}

/** Bulk-dispatch failures, surfaced only in the notification bell (not Workspace's
 * Upcoming Tasks -- a separate concern from "who needs my attention" reminders).
 * Admin-only, same gate as the Bulk Activity entry point itself. Reuses the exact
 * same query key MainLayout prefetches on load, so this rides that warm cache
 * instead of firing its own separate request. */
export function useBulkDispatchAlerts() {
  const { user } = useAuthStore();
  const { data } = useQuery({
    queryKey: ['bulk-jobs-recent'],
    queryFn: () => listRecentBulkJobs(20),
    enabled: user?.role === 'admin',
    staleTime: 30_000,
  });

  const alerts: BulkFailureAlert[] = (data?.jobs ?? [])
    .filter((j) => j.failed_count > 0)
    .map((j) => ({
      kind: 'bulk_failure',
      sortKey: new Date(j.updated_at).getTime(),
      jobId: j.id,
      seq: j.seq,
      failedCount: j.failed_count,
    }));

  return { alerts };
}
