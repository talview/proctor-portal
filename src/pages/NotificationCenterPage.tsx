import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDistance } from 'date-fns';
import { Bell, BellOff } from 'lucide-react';
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
import EmptyState from '@/components/ui/EmptyState';
import Button from '@/components/ui/Button';

const GROUP_ORDER: NotificationGroup[] = ['New', 'Today', 'Earlier'];
const TABS: { key: NotificationTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'action', label: 'Action Required' },
  { key: 'updates', label: 'Updates' },
];

/** The full, unbounded counterpart to the notification bell's floating
 * panel -- "View all notifications" lands here. Same data, same grouping,
 * same read-state (see src/utils/notifications.ts and
 * useNotificationReadState), just without the panel's 8-item cap. */
export default function NotificationCenterPage() {
  const [tab, setTab] = useState<NotificationTab>('all');
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const now = useNetworkTime();
  const { items: reminders, isLoading } = useUpcomingReminders();
  const { alerts } = useBulkDispatchAlerts();
  const { items: updates } = useActivityUpdates();
  const openBulkActivity = useUIStore((s) => s.openBulkActivity);
  const { isRead, markRead, markAllRead } = useNotificationReadState();

  const today = localDateString(now);
  const items: NotificationEntry[] = [...alerts, ...reminders, ...updates];
  const unreadCount = items.filter((item) => !isRead(entryKey(item))).length;

  const openEntry = (item: NotificationEntry) => {
    markRead(entryKey(item));
    const dest = entryDestination(item, user?.role);
    if (dest.kind === 'bulk-activity') openBulkActivity(dest.jobId);
    else navigate(dest.path, { state: dest.state });
  };

  const filtered = tab === 'all' ? items : items.filter((item) => entryCategory(item) === (tab === 'action' ? 'action' : 'update'));

  const grouped: Record<NotificationGroup, NotificationEntry[]> = { New: [], Today: [], Earlier: [] };
  for (const item of filtered) grouped[groupLabelFor(item, now)].push(item);

  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-6 flex-wrap">
        <div>
          <h2 className="text-[20px] font-bold text-text">Notifications</h2>
          <p className="text-[13px] text-text2 mt-0.5">
            {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
          </p>
        </div>
        {unreadCount > 0 && (
          <Button variant="ghost" size="sm" onClick={() => markAllRead(items.map(entryKey))}>
            Mark all as read
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1.5 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`text-[12px] font-semibold px-3 py-1.5 rounded-full border transition-colors ${
              tab === t.key ? 'bg-accent/10 text-accent border-accent/30' : 'bg-surface border-border text-text2 hover:border-border2'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        {isLoading ? (
          <p className="text-[12px] text-text3 text-center py-16">Loading…</p>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={tab === 'updates' ? BellOff : Bell}
            title={tab === 'updates' ? 'No updates yet' : "You're all caught up"}
            message={tab === 'updates' ? 'General updates will show up here once there are any.' : undefined}
          />
        ) : (
          <div className="divide-y divide-border">
            {GROUP_ORDER.map((group) =>
              grouped[group].length === 0 ? null : (
                <div key={group}>
                  <div className="px-4 pt-3 pb-1.5 text-[10px] font-bold text-text3 uppercase tracking-wide bg-surface2">{group}</div>
                  {grouped[group].map((item) => {
                    const Icon = entryIcon(item);
                    const tone = entryTone(item, today);
                    const unread = !isRead(entryKey(item));
                    return (
                      <button
                        key={entryKey(item)}
                        type="button"
                        onClick={() => openEntry(item)}
                        className="w-full flex items-start gap-3 text-left px-4 py-3 hover:bg-surface2 transition-colors border-b border-border last:border-b-0"
                      >
                        <span className={`mt-0.5 flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${TONE_STYLES[tone].chip}`}>
                          <Icon className="w-3.5 h-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-semibold text-text truncate">{entryTitle(item)}</span>
                            {unread && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${TONE_STYLES[tone].dot}`} />}
                          </div>
                          <div className="text-[11.5px] text-text3 truncate mt-0.5">{entryDescription(item)}</div>
                        </div>
                        <div className="flex flex-col items-end gap-1 flex-shrink-0">
                          <span className="text-[10.5px] text-text3 whitespace-nowrap">
                            {formatDistance(new Date(entryEventTime(item)), now, { addSuffix: true })}
                          </span>
                          <span className="text-[11px] font-semibold text-accent whitespace-nowrap">{entryActionLabel(item)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
