import { Award, Calendar, CalendarCheck2, FileCheck2, FileWarning, Mail, Send, ShieldCheck, UserCheck, UserPlus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { localDateString } from '@/utils/formatters';
import {
  reminderTitle,
  reminderDescription,
  reminderBadge,
  type ReminderItem,
  type BulkFailureAlert,
} from '@/hooks/useUpcomingReminders';
import type { ActivityUpdateItem } from '@/hooks/useActivityUpdates';

/** Shared between the notification bell's floating panel and the full
 * Notification Center page so the two can never drift apart.
 *
 * Two different kinds of truth feed this: ReminderItem/BulkFailureAlert are
 * live-derived "needs attention" facts with no backend row of their own (see
 * useUpcomingReminders) -- always "action" category. ActivityUpdateItem is
 * built from real audit_log rows and completed bulk-dispatch jobs (see
 * useActivityUpdates) -- always "update" category. Nothing here invents data
 * that isn't backed by one of those two hooks. */
export type NotificationEntry = ReminderItem | BulkFailureAlert | ActivityUpdateItem;
export type NotificationTab = 'all' | 'action' | 'updates';
export type NotificationGroup = 'New' | 'Today' | 'Earlier';
export type NotificationTone = 'danger' | 'warning' | 'info';

export function entryIcon(item: NotificationEntry): LucideIcon {
  switch (item.kind) {
    case 'eval':
      return Calendar;
    case 'nda':
      return Mail;
    case 'bulk_failure':
      return FileWarning;
    case 'bulk_shared':
      return Send;
    case 'bulk_completion':
      return item.jobType === 'send_pre_onboarding_form' ? FileCheck2 : ShieldCheck;
    case 'activity':
      switch (item.subtype) {
        case 'verified':
          return UserCheck;
        case 'activated':
          return UserPlus;
        case 'certified':
          return Award;
        default:
          return CalendarCheck2; // ready_demo / ready_assessment
      }
  }
}

export function entryKey(item: NotificationEntry): string {
  if (item.kind === 'eval') return `${item.kind}-${item.evalType}-${item.date}`;
  if (item.kind === 'nda') return `${item.kind}-${item.proctor.id}`;
  if (item.kind === 'bulk_failure' || item.kind === 'bulk_shared' || item.kind === 'bulk_completion') return `${item.kind}-${item.jobId}`;
  return `${item.kind}-${item.subtype}-${item.actorLabel}-${item.sortKey}`;
}

const JOB_TYPE_LABEL: Record<'send_pre_onboarding_form' | 'send_onboarding_docs', string> = {
  send_pre_onboarding_form: 'Pre-Onboarding Form',
  send_onboarding_docs: 'NDA & Documents',
};

function activityVerb(item: Extract<ActivityUpdateItem, { kind: 'activity' }>): string {
  switch (item.subtype) {
    case 'verified':
      return 'verified';
    case 'activated':
      return 'activated';
    case 'ready_demo':
      return 'marked ready for demo';
    case 'ready_assessment':
      return 'marked ready for assessment';
    case 'certified':
      return 'certified';
  }
}

export function entryTitle(item: NotificationEntry): string {
  switch (item.kind) {
    case 'bulk_failure':
      return `${item.failedCount} email${item.failedCount === 1 ? '' : 's'} failed — Bulk Activity #${item.seq}`;
    case 'bulk_shared':
      return `${item.actorLabel} shared the ${JOB_TYPE_LABEL[item.jobType]} with ${item.sentCount} proctor${item.sentCount === 1 ? '' : 's'}`;
    case 'bulk_completion':
      return `${item.completedCount} of ${item.totalCount} proctors have ${
        item.jobType === 'send_pre_onboarding_form' ? 'filled the Pre-Onboarding Form' : 'signed NDA documents'
      } — Bulk Activity #${item.jobSeq}`;
    case 'activity':
      if (item.count === 1) return `${item.proctorName} — ${activityVerb(item)}`;
      return `${item.actorLabel} ${activityVerb(item)} ${item.count} proctors`;
    default:
      return reminderTitle(item);
  }
}

export function entryDescription(item: NotificationEntry): string {
  switch (item.kind) {
    case 'bulk_failure':
    case 'bulk_shared':
    case 'bulk_completion':
      return 'Open Bulk Activity for details';
    case 'activity':
      return item.count === 1 ? `by ${item.actorLabel}` : 'Bulk action';
    default:
      return reminderDescription(item);
  }
}

export function entryActionLabel(item: NotificationEntry): string {
  switch (item.kind) {
    case 'bulk_failure':
      return 'Review failure';
    case 'bulk_shared':
    case 'bulk_completion':
      return 'Open Bulk Activity';
    case 'nda':
      return 'View proctor';
    case 'eval':
      return `Review ${item.evalType === 'demo' ? 'demos' : 'assessments'}`;
    case 'activity':
      return item.count === 1 ? 'View proctor' : 'View proctors';
  }
}

/** ReminderItem/BulkFailureAlert are always something to act on; every
 * ActivityUpdateItem is always a general update -- the split follows
 * directly from which hook produced the entry, not a per-item judgment
 * call. */
export function entryCategory(item: NotificationEntry): 'action' | 'update' {
  return item.kind === 'activity' || item.kind === 'bulk_shared' || item.kind === 'bulk_completion' ? 'update' : 'action';
}

/** Red only for a real failure (bulk-send); amber for the same danger/warning
 * split Workspace's own reminder cards already use; blue/neutral for every
 * general update, per the explicit "red only for failures" instruction. */
export function entryTone(item: NotificationEntry, today: string): NotificationTone {
  if (item.kind === 'bulk_failure') return 'danger';
  if (item.kind === 'activity' || item.kind === 'bulk_shared' || item.kind === 'bulk_completion') return 'info';
  return reminderBadge(item, today).tone;
}

export const TONE_STYLES: Record<NotificationTone, { chip: string; dot: string }> = {
  danger: { chip: 'bg-danger/10 text-danger', dot: 'bg-danger' },
  warning: { chip: 'bg-warning/10 text-warning', dot: 'bg-warning' },
  info: { chip: 'bg-info/10 text-info', dot: 'bg-info' },
};

/** Every entry's `sortKey` is already a real point in time (a job's
 * updated_at, an audit row's created_at, an evaluation's due date, an NDA
 * link's expiry) -- reused directly as the "event time" for both relative-
 * time display and New/Today/Earlier bucketing, so there's exactly one
 * timestamp per entry, not two that could disagree. */
export function entryEventTime(item: NotificationEntry): number {
  return item.sortKey;
}

/** "New" applies to a bulk-send failure or an activity/bulk update less than
 * an hour old -- all three have a genuine "this just happened" timestamp (a
 * job's updated_at or an audit row's created_at). An evaluation or NDA
 * reminder only carries a due/expiry date, never a creation time, so it can
 * never honestly be "new" in that sense -- it's bucketed by whether that date
 * falls on today's calendar date instead. */
export function groupLabelFor(item: NotificationEntry, now: Date): NotificationGroup {
  const eventMs = entryEventTime(item);
  const ageMs = now.getTime() - eventMs;
  const hasCreationTimestamp = item.kind === 'bulk_failure' || item.kind === 'activity' || item.kind === 'bulk_shared' || item.kind === 'bulk_completion';
  if (hasCreationTimestamp && ageMs >= 0 && ageMs < 60 * 60_000) return 'New';
  return localDateString(new Date(eventMs)) === localDateString(now) ? 'Today' : 'Earlier';
}

export type EntryDestination =
  | { kind: 'route'; path: string; state?: unknown }
  | { kind: 'bulk-activity'; jobId: string };

/** Where clicking an entry should go -- centralized so the floating panel and
 * the full Notification Center page never disagree about it. Bulk-send
 * failures and bulk progress always resolve inside the Activity Center
 * (never a page of their own), per the explicit separation between
 * Notifications and Bulk Activity. */
export function entryDestination(item: NotificationEntry, role?: string): EntryDestination {
  if (item.kind === 'eval') {
    return { kind: 'route', path: '/scheduled-events', state: { filters: { date: item.date, type: item.evalType } } };
  }
  if (item.kind === 'nda') {
    return {
      kind: 'route',
      path: role === 'admin' ? '/proctors' : '/my-proctors',
      state: { openProctorId: item.proctor.id },
    };
  }
  if (item.kind === 'bulk_failure' || item.kind === 'bulk_shared' || item.kind === 'bulk_completion') {
    return { kind: 'bulk-activity', jobId: item.jobId };
  }
  // 'activity' -- audit_log only ever stored a proctor's name, never an id
  // (see ProctorsPage's logAudit calls), so a single-proctor update can only
  // pre-fill the search box, not deep-link to a specific drawer.
  return {
    kind: 'route',
    path: '/proctors',
    state: item.count === 1 ? { searchQuery: item.proctorName } : undefined,
  };
}
