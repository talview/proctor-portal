import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistance } from 'date-fns';
import { Bell, X } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { useNetworkTime } from '@/hooks/useNetworkTime';
import { useNotificationReadState } from '@/hooks/useNotificationReadState';
import { useUpcomingReminders, useBulkDispatchAlerts } from '@/hooks/useUpcomingReminders';
import { useActivityUpdates } from '@/hooks/useActivityUpdates';
import {
  TONE_STYLES,
  entryActionLabel,
  entryCategory,
  entryDescription,
  entryDestination,
  entryEventTime,
  entryIcon,
  entryKey,
  entryTitle,
  entryTone,
  groupLabelFor,
  type NotificationEntry,
  type NotificationGroup,
  type NotificationTab,
} from '@/utils/notifications';
import { localDateString } from '@/utils/formatters';

const PANEL_WIDTH = 410;
const PANEL_MARGIN = 12; // never closer than this to any viewport edge
const PANEL_MAX_ITEMS = 8; // the floating panel is a glance, not the full list
const GROUP_ORDER: NotificationGroup[] = ['New', 'Today', 'Earlier'];
const TABS: { key: NotificationTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'action', label: 'Action Required' },
  { key: 'updates', label: 'Updates' },
];

interface PanelPosition {
  top: number;
  left: number;
  width: number;
  arrowLeft: number;
}

/** No dedicated notifications table/backend exists (see useUpcomingReminders
 * and useNotificationReadState) -- this is a live view of the same "needs
 * attention right now" data Workspace's Upcoming Tasks panel already
 * computes, plus admin-only bulk-send failure alerts, presented as a
 * floating popover (not a drawer/modal -- the page behind it stays visible
 * and usable) with client-side-only read state. */
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<NotificationTab>('all');
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const now = useNetworkTime();
  const { items: reminders } = useUpcomingReminders();
  const { alerts } = useBulkDispatchAlerts();
  const { items: updates } = useActivityUpdates();
  const openBulkActivity = useUIStore((s) => s.openBulkActivity);
  const { isRead, markRead, markAllRead } = useNotificationReadState();

  const today = localDateString(now);

  // Failures surface first -- they're the one entry kind that means something
  // already went wrong, not just "coming up soon." Updates (general activity)
  // sort last -- they're informational, never the reason someone opened this.
  const items: NotificationEntry[] = useMemo(() => [...alerts, ...reminders, ...updates], [alerts, reminders, updates]);
  const unreadCount = items.filter((item) => !isRead(entryKey(item))).length;

  const computePosition = () => {
    const rect = bellRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Bound against the content area (<main>, everything right of the
    // sidebar) rather than the raw viewport -- the sidebar stays visible as
    // a fixed icon rail even on mobile (it doesn't collapse into a drawer),
    // so clamping to window bounds would slide the panel underneath it.
    const bounds = bellRef.current?.closest('main')?.getBoundingClientRect() ?? {
      left: 0,
      right: window.innerWidth,
    };
    const maxWidth = bounds.right - bounds.left - PANEL_MARGIN * 2;
    const width = Math.min(PANEL_WIDTH, maxWidth);
    const left = Math.min(Math.max(rect.right - width, bounds.left + PANEL_MARGIN), bounds.right - width - PANEL_MARGIN);
    const top = rect.bottom + 10;
    const bellCenter = rect.left + rect.width / 2;
    const arrowLeft = Math.min(Math.max(bellCenter - left - 6, 14), width - 26);
    setPosition({ top, left, width, arrowLeft });
  };

  // Fixed-viewport positioning, recomputed on open and on resize -- the
  // topbar itself is sticky (never scrolls with the page), so no scroll
  // listener is needed to keep the panel anchored to the bell.
  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
    window.addEventListener('resize', computePosition);
    return () => window.removeEventListener('resize', computePosition);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (bellRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const openEntry = (item: NotificationEntry) => {
    markRead(entryKey(item));
    setOpen(false);
    const dest = entryDestination(item, user?.role);
    if (dest.kind === 'bulk-activity') openBulkActivity(dest.jobId);
    else navigate(dest.path, { state: dest.state });
  };

  const filtered = tab === 'all' ? items : items.filter((item) => entryCategory(item) === (tab === 'action' ? 'action' : 'update'));
  const visible = filtered.slice(0, PANEL_MAX_ITEMS);

  const grouped: Record<NotificationGroup, NotificationEntry[]> = { New: [], Today: [], Earlier: [] };
  for (const item of visible) grouped[groupLabelFor(item, now)].push(item);

  // Workspace/Notification Center are admin/coordinator-only (see RoleGate in
  // App.tsx) -- a vendor's reminder list is always empty anyway, but skip the
  // dead-end link regardless.
  const showViewAll = user?.role !== 'vendor';

  return (
    <div className="relative inline-block">
      <button
        ref={bellRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 text-text3 hover:text-text hover:bg-surface2 rounded-lg transition-colors"
        title="Notifications"
      >
        <Bell className="w-[18px] h-[18px]" />
        {unreadCount > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[15px] h-[15px] px-[3px] rounded-full bg-danger text-white text-[9px] font-bold flex items-center justify-center leading-none">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && position && (
        <div
          ref={panelRef}
          style={{ position: 'fixed', top: position.top, left: position.left, width: position.width, maxHeight: '68vh' }}
          className="z-50 flex flex-col bg-surface border border-border2 rounded-xl shadow-2xl overflow-hidden animate-fade-drop-in"
        >
          {/* Pointer connecting the panel back to the bell */}
          <div
            className="absolute -top-[6px] w-3 h-3 bg-surface border-l border-t border-border2 rotate-45"
            style={{ left: position.arrowLeft }}
          />

          <div className="px-4 pt-3.5 pb-3 border-b border-border flex-shrink-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-[14px] font-bold text-text">Notifications</h3>
                <p className="text-[11px] text-text3 mt-0.5">{unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}</p>
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={() => markAllRead(items.map(entryKey))}
                    className="text-[11px] font-semibold text-accent hover:underline px-1.5 py-1 whitespace-nowrap"
                  >
                    Mark all as read
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="p-1 rounded text-text3 hover:text-text hover:bg-surface2"
                  aria-label="Close notifications"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex items-center gap-1.5 mt-3">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap ${
                    tab === t.key
                      ? 'bg-accent/10 text-accent border-accent/30'
                      : 'bg-surface border-border text-text2 hover:border-border2'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-y-auto flex-1 min-h-0">
            {visible.length === 0 ? (
              <p className="text-[12px] text-text3 text-center py-10">
                {tab === 'updates' ? 'No updates yet' : "You're all caught up"}
              </p>
            ) : (
              GROUP_ORDER.map((group) =>
                grouped[group].length === 0 ? null : (
                  <div key={group}>
                    <div className="px-4 pt-2.5 pb-1 text-[10px] font-bold text-text3 uppercase tracking-wide">{group}</div>
                    {grouped[group].map((item) => {
                      const Icon = entryIcon(item);
                      const tone = entryTone(item, today);
                      const unread = !isRead(entryKey(item));
                      return (
                        <button
                          key={entryKey(item)}
                          type="button"
                          onClick={() => openEntry(item)}
                          className="w-full flex items-start gap-2.5 text-left px-4 py-2.5 hover:bg-surface2 transition-colors"
                        >
                          <span className={`mt-0.5 flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${TONE_STYLES[tone].chip}`}>
                            <Icon className="w-3 h-3" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12.5px] font-semibold text-text truncate">{entryTitle(item)}</span>
                              {unread && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${TONE_STYLES[tone].dot}`} />}
                            </div>
                            <div className="text-[11px] text-text3 truncate mt-0.5">{entryDescription(item)}</div>
                            <div className="flex items-center justify-between gap-2 mt-1">
                              <span className="text-[10px] text-text3 whitespace-nowrap">
                                {formatDistance(new Date(entryEventTime(item)), now, { addSuffix: true })}
                              </span>
                              <span className="text-[10.5px] font-semibold text-accent flex-shrink-0 whitespace-nowrap">
                                {entryActionLabel(item)}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )
              )
            )}
          </div>

          {showViewAll && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate('/notifications');
              }}
              className="w-full text-center text-[11px] font-semibold text-accent hover:underline py-2.5 border-t border-border flex-shrink-0"
            >
              View all notifications
            </button>
          )}
        </div>
      )}
    </div>
  );
}
