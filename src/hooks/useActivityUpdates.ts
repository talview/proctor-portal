import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth';
import { listRecentBulkJobs, getBulkJobItems, type BulkJobType } from '@/services/bulkDispatch';

/** The specific audit_log `action` strings this feed understands -- a
 * deliberately short, curated list (proctor lifecycle + bulk-send progress),
 * not "everything in the Audit Log." Adding a new one here is how a future
 * action type joins the Updates tab. */
const ACTIVITY_ACTIONS = ['Verified', 'ID Assigned', 'Marked Demo Ready', 'Marked Assessment Ready', 'Client Certified'] as const;
type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export type ActivitySubtype = 'verified' | 'activated' | 'ready_demo' | 'ready_assessment' | 'certified';

const ACTIVITY_SUBTYPE: Record<ActivityAction, ActivitySubtype> = {
  Verified: 'verified',
  'ID Assigned': 'activated',
  'Marked Demo Ready': 'ready_demo',
  'Marked Assessment Ready': 'ready_assessment',
  'Client Certified': 'certified',
};

export interface ActivityItem {
  kind: 'activity';
  subtype: ActivitySubtype;
  sortKey: number;
  actorLabel: string;
  count: number;
  /** Only meaningful when count === 1 -- audit_log's `target` is a name, not
   * an id (see ProctorsPage's logAudit calls), so this is a display string,
   * not something that can deep-link to a specific record. */
  proctorName?: string;
}

export interface BulkSharedItem {
  kind: 'bulk_shared';
  sortKey: number;
  actorLabel: string;
  jobId: string;
  jobSeq: number;
  jobType: BulkJobType;
  sentCount: number;
}

export interface BulkCompletionItem {
  kind: 'bulk_completion';
  sortKey: number;
  jobId: string;
  jobSeq: number;
  jobType: BulkJobType;
  completedCount: number;
  totalCount: number;
}

export type ActivityUpdateItem = ActivityItem | BulkSharedItem | BulkCompletionItem;

const AGGREGATION_WINDOW_MS = 10 * 60_000; // same actor + action within 10 min -> one bucket
const RECENT_DAYS = 14;
const MAX_COMPLETION_JOBS = 5; // bounds the per-job items fetch fan-out below

/** General-purpose "what's been happening" updates -- distinct from
 * useUpcomingReminders (which is "what still needs attention"). Three
 * sources, all real, none inventing new backend state:
 *
 * 1. audit_log rows for a curated set of proctor-lifecycle actions.
 *    Bulk Verify/Activate/Set-Ready used to log nothing at all (see
 *    ProctorsPage.tsx) -- they now log one row per proctor, same shape as
 *    the existing single-item actions, and this hook re-aggregates
 *    consecutive same-actor/same-action rows into one bucket ("Sai verified
 *    35 proctors") instead of showing 35 separate entries.
 * 2. Completed bulk-dispatch jobs themselves ("shared the Pre-Onboarding
 *    Form with N proctors") -- no query needed beyond the job row already
 *    fetched for the bell's failure alerts.
 * 3. Live completion progress for those same jobs ("6 of 7 have filled the
 *    Pre-Onboarding Form") -- computed by joining each job's *sent* items
 *    against proctors' current form_status/nda_status, since nothing stores
 *    "form completed while under bulk job X" as a discrete event.
 *
 * Admin-only: audit_log's RLS policy only grants SELECT to admin (migration
 * 0003), so every query here is gated the same way useBulkDispatchAlerts
 * already is -- a no-op, not an error, for coordinator/vendor.
 */
export function useActivityUpdates() {
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';
  const since = useMemo(() => new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString(), []);

  const { data: auditRows = [] } = useQuery({
    queryKey: ['activity-updates-audit', since],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_log')
        .select('action, target, usr, ts')
        .in('action', ACTIVITY_ACTIONS as unknown as string[])
        .gte('ts', since)
        .order('ts', { ascending: false })
        .limit(300);
      if (error) throw error;
      return data as { action: ActivityAction; target: string; usr: string | null; ts: string }[];
    },
    enabled: isAdmin,
    staleTime: 30_000,
  });

  // Shares the exact same query the bell's bulk-failure alerts already fetch
  // (see useBulkDispatchAlerts) -- one cache entry, two consumers.
  const { data: jobsData } = useQuery({
    queryKey: ['bulk-jobs-recent'],
    queryFn: () => listRecentBulkJobs(20),
    enabled: isAdmin,
    staleTime: 30_000,
  });
  const jobs = useMemo(() => jobsData?.jobs ?? [], [jobsData]);
  const completedJobs = useMemo(() => jobs.filter((j) => j.status === 'completed' && j.sent_count > 0), [jobs]);

  // audit_log's `usr` and bulk_dispatch_jobs' `created_by` are both the acting
  // session's email (see log_audit() and bulk-dispatch-create/index.ts) --
  // resolved together here to a real display name, or the vendor's company
  // name for a vendor actor, so "vendor Sai verified..."/"...shared..." reads
  // the way the user actually described it rather than a raw email address.
  const actorEmails = useMemo(
    () => Array.from(new Set([...auditRows.map((r) => r.usr), ...completedJobs.map((j) => j.created_by)].filter((v): v is string => !!v))),
    [auditRows, completedJobs]
  );

  const { data: actorLabels = {} } = useQuery({
    queryKey: ['activity-updates-actors', actorEmails.slice().sort().join(',')],
    queryFn: async () => {
      const { data, error } = await supabase.from('users').select('email, name, username, role, vendors(name)').in('email', actorEmails);
      if (error) throw error;
      const map: Record<string, string> = {};
      for (const row of data as unknown as { email: string; name: string | null; username: string; role: string; vendors: { name: string } | null }[]) {
        map[row.email] = row.role === 'vendor' && row.vendors?.name ? row.vendors.name : row.name || row.username;
      }
      return map;
    },
    enabled: isAdmin && actorEmails.length > 0,
    staleTime: 5 * 60_000,
  });

  const activityItems: ActivityItem[] = useMemo(() => {
    // Walk oldest-first so each bucket's window anchors on its first member.
    const chronological = [...auditRows].reverse();
    const openByKey = new Map<string, ActivityItem & { _lastMs: number }>();
    const ordered: (ActivityItem & { _lastMs: number })[] = [];
    for (const row of chronological) {
      const ms = new Date(row.ts).getTime();
      const key = `${row.action}|${row.usr || ''}`;
      const open = openByKey.get(key);
      const actorLabel = (row.usr && actorLabels[row.usr]) || row.usr || 'Someone';
      if (open && ms - open._lastMs <= AGGREGATION_WINDOW_MS) {
        open.count += 1;
        open.sortKey = ms;
        open._lastMs = ms;
        open.proctorName = undefined;
      } else {
        const item = {
          kind: 'activity' as const,
          subtype: ACTIVITY_SUBTYPE[row.action],
          sortKey: ms,
          actorLabel,
          count: 1,
          proctorName: row.target,
          _lastMs: ms,
        };
        openByKey.set(key, item);
        ordered.push(item);
      }
    }
    return ordered.map(({ _lastMs, ...rest }) => rest);
  }, [auditRows, actorLabels]);

  const sharedItems: BulkSharedItem[] = useMemo(
    () =>
      completedJobs.map((j) => ({
        kind: 'bulk_shared' as const,
        sortKey: new Date(j.updated_at).getTime(),
        actorLabel: actorLabels[j.created_by] || j.created_by,
        jobId: j.id,
        jobSeq: j.seq,
        jobType: j.job_type,
        sentCount: j.sent_count,
      })),
    [completedJobs, actorLabels]
  );

  const completionCandidates = useMemo(() => completedJobs.slice(0, MAX_COMPLETION_JOBS), [completedJobs]);

  const itemQueries = useQueries({
    queries: completionCandidates.map((job) => ({
      queryKey: ['bulk-job-items-for-completion', job.id],
      queryFn: () => getBulkJobItems(job.id),
      enabled: isAdmin,
      staleTime: 60_000,
    })),
  });

  const allSentProctorIds = useMemo(
    () => Array.from(new Set(itemQueries.flatMap((q) => (q.data?.items ?? []).filter((it) => it.status === 'sent').map((it) => it.proctor_id)))),
    [itemQueries]
  );

  const { data: proctorStates = [] } = useQuery({
    queryKey: ['bulk-completion-proctor-states', allSentProctorIds.slice().sort().join(',')],
    queryFn: async () => {
      const { data, error } = await supabase.from('proctors').select('id, form_status, nda_status').in('id', allSentProctorIds);
      if (error) throw error;
      return data as { id: string; form_status: string | null; nda_status: string | null }[];
    },
    enabled: isAdmin && allSentProctorIds.length > 0,
    staleTime: 30_000,
  });

  const completionItems: BulkCompletionItem[] = useMemo(() => {
    const stateById = new Map(proctorStates.map((p) => [p.id, p]));
    const items: BulkCompletionItem[] = [];
    completionCandidates.forEach((job, i) => {
      const sentIds = (itemQueries[i]?.data?.items ?? []).filter((it) => it.status === 'sent').map((it) => it.proctor_id);
      if (sentIds.length === 0) return;
      const completedCount = sentIds.filter((id) => {
        const state = stateById.get(id);
        if (!state) return false;
        return job.job_type === 'send_pre_onboarding_form' ? state.form_status === 'submitted' : state.nda_status === 'NDA Signed';
      }).length;
      if (completedCount === 0) return;
      items.push({
        kind: 'bulk_completion',
        sortKey: new Date(job.updated_at).getTime(),
        jobId: job.id,
        jobSeq: job.seq,
        jobType: job.job_type,
        completedCount,
        totalCount: sentIds.length,
      });
    });
    return items;
    // itemQueries' identity changes every render (useQueries returns a fresh
    // array), so it's intentionally left out of the deps -- proctorStates and
    // completionCandidates already change whenever the underlying data does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completionCandidates, proctorStates]);

  // Most-recent-first, like any activity feed -- the three sources above are
  // each internally ordered by their own construction, not globally by time.
  const items: ActivityUpdateItem[] = useMemo(
    () => [...activityItems, ...sharedItems, ...completionItems].sort((a, b) => b.sortKey - a.sortKey),
    [activityItems, sharedItems, completionItems]
  );

  return { items };
}
