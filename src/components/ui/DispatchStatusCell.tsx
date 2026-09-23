import { History, Circle, Send, Eye, Clock, XCircle, CheckCircle2, Loader2, type LucideIcon } from 'lucide-react';
import type { BulkDispatchItem } from '@/services/bulkDispatch';

export interface DispatchFlowState {
  /** Terminal -- the candidate has finished this flow (form submitted / NDA signed /
   * docs uploaded). Takes priority over everything else. */
  completed: boolean;
  /** The current link/session passed its expiry without completing. Only meaningful
   * pre-completion -- callers should only pass true here when not yet completed. */
  expired: boolean;
  /** Real evidence the candidate opened it (form_access_count > 0 for the
   * pre-onboarding form, nda_viewed_at set for NDA/docs) -- independent of whether
   * they've finished. */
  viewed: boolean;
  /** Timestamp of the most recent successful send (form_shared_at / nda_triggered_at).
   * Both dispatch paths (the individual button and the bulk system) update this on
   * every successful send, so it always reflects the latest one regardless of which
   * path sent it -- used to order a dispatch failure against it by recency. */
  lastSucceededAt: string | null | undefined;
}

/** One shared status cell for the pre-onboarding form (Interview Selects' Form Status
 * column) and onboarding NDA/docs (Proctors' NDA and Documents columns -- both driven
 * by the same send/view timestamps, just two independently-completable actions on one
 * session). Same terminology (Not Sent / Sent / Viewed / Completed, Expired/Failed as
 * overlays), same "what actually happened most recently" logic, in one place so a fix
 * here can't land in one column and not the others again.
 *
 * Each state also gets its own icon, not just a color -- Sent/Viewed share a color
 * family (both mean "no problem, just different progress") and Expired/Failed share
 * another, so color alone would collapse two different states into one signal at a
 * glance. Icon shape carries the distinction color can't.
 *
 * The primary badge always reflects the single most recent event, including a failed
 * send/resend -- a failure is never demoted to a footnote under a stale "Sent" just
 * because something succeeded further in the past. When a failure supersedes (or is
 * superseded by) an earlier success, that earlier fact is still available, just moved
 * to the small history icon rather than competing for the primary badge.
 *
 * The individual "Re-send" button and the bulk-dispatch system are two separate send
 * paths -- only the bulk one is tracked in bulk_dispatch_items, which never gets
 * updated by an unrelated individual resend. `lastSucceededAt` (set by both paths on
 * every success) is what lets this cell order a bulk-tracked failure against a
 * possibly-later individual success it knows nothing about.
 */
export default function DispatchStatusCell({
  flow,
  dispatch,
}: {
  flow: DispatchFlowState;
  dispatch: Pick<BulkDispatchItem, 'status' | 'failure_reason' | 'attempted_at'> | undefined;
}) {
  const hasEverSucceeded = flow.completed || !!flow.lastSucceededAt;

  // A dispatch failure is the *current* headline only if nothing more recent
  // superseded it -- no success on record at all, or this attempt happened after the
  // last one. Missing attempted_at fails open (treated as current) since understating
  // a real failure is worse than the reverse.
  const failureIsCurrent =
    dispatch?.status === 'failed' &&
    (!flow.lastSucceededAt || !dispatch.attempted_at || new Date(dispatch.attempted_at) > new Date(flow.lastSucceededAt));
  const failureIsStale = dispatch?.status === 'failed' && !failureIsCurrent;

  let primary: { label: string; className: string; Icon: LucideIcon };
  let historyNote: string | null = null;

  if (flow.completed) {
    primary = { label: 'Completed', className: 'text-success', Icon: CheckCircle2 };
    if (failureIsStale) historyNote = 'An earlier resend attempt failed before this completed.';
  } else if (failureIsCurrent) {
    primary = { label: 'Failed', className: 'text-danger', Icon: XCircle };
    if (hasEverSucceeded) historyNote = 'A working link was sent successfully before this attempt failed.';
  } else if (flow.expired) {
    primary = { label: 'Expired', className: 'text-danger', Icon: Clock };
    if (failureIsStale) historyNote = 'An earlier resend attempt failed; this link expired regardless.';
  } else if (flow.viewed) {
    primary = { label: 'Viewed', className: 'text-accent', Icon: Eye };
    if (failureIsStale) historyNote = 'An earlier resend attempt failed before this was viewed.';
  } else if (hasEverSucceeded) {
    primary = { label: 'Sent', className: 'text-accent', Icon: Send };
    if (failureIsStale) historyNote = 'An earlier resend attempt failed after this was sent.';
  } else {
    primary = { label: 'Not Sent', className: 'text-text3', Icon: Circle };
  }

  const { Icon } = primary;
  const isSending = dispatch?.status === 'processing';

  return (
    <div>
      <div className="flex items-center gap-1">
        {isSending ? (
          <Loader2 className="w-3 h-3 text-accent animate-spin flex-shrink-0" />
        ) : (
          <Icon className={`w-3 h-3 flex-shrink-0 ${primary.className}`} />
        )}
        <span className={`text-[11px] font-bold whitespace-nowrap ${primary.className}`}>{primary.label}</span>
        {historyNote && (
          <span title={historyNote}>
            <History className="w-3 h-3 text-text3 flex-shrink-0" />
          </span>
        )}
      </div>
      {isSending && (
        <div className="text-[10px] text-accent mt-0.5">Sending…</div>
      )}
      {failureIsCurrent && dispatch?.failure_reason && (
        <div className="text-[10px] text-text3 mt-0.5" title={dispatch.failure_reason}>
          {dispatch.failure_reason}
        </div>
      )}
    </div>
  );
}
