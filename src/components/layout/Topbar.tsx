import { useLocation } from 'react-router-dom';
import { Search, ListChecks } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { getNavSections, findActiveItem } from '@/config/navigation';
import ThemeToggle from '@/components/ui/ThemeToggle';
import NotificationBell from '@/components/ui/NotificationBell';
import { useCommandPaletteStore } from '@/stores/commandPalette';
import { useNetworkTime } from '@/hooks/useNetworkTime';

/** No more page-switcher pill bar -- the sidebar is now a flat, direct list (see
 * Sidebar's own doc comment), so the topbar's job shrinks to just naming the
 * current page and hosting the command palette's trigger, moved here into a real
 * search-bar-shaped control (matching the Proctor OS artifact's topbar) instead
 * of a small pill tucked on the right. */
export default function Topbar() {
  const { user } = useAuthStore();
  const location = useLocation();
  // Network-synced, not the machine's own system clock -- see useNetworkTime.
  const now = useNetworkTime();
  const openCommandPalette = useCommandPaletteStore((s) => s.setOpen);
  const openBulkActivity = useUIStore((s) => s.openBulkActivity);

  const activeItem = findActiveItem(getNavSections(user?.role), location.pathname);
  const istTime = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  const utcTime = now.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

  return (
    <div className="bg-surface border-b border-border dark:border-white/5 px-6 h-14 flex items-center gap-4 sticky top-0 z-40 shadow-sm">
      <h1 className="font-display font-semibold text-[15px] text-text whitespace-nowrap flex-shrink-0">
        {/* Notification Center has no sidebar entry (reached only via the bell's
            "View all notifications"), so it isn't in getNavSections and
            findActiveItem can't title it -- named explicitly instead of
            falling back to "Dashboard". */}
        {activeItem?.label ?? (location.pathname === '/notifications' ? 'Notifications' : 'Dashboard')}
      </h1>

      <button
        type="button"
        onClick={() => openCommandPalette(true)}
        className="flex-1 max-w-[420px] flex items-center gap-2 bg-surface2 border border-border hover:border-border2 rounded-lg px-3 py-1.5 text-text3 transition-colors"
        title="Quick navigation"
      >
        <Search className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="text-[12.5px] flex-1 text-left truncate">Search proctors, vendors, actions…</span>
        <kbd className="text-[10px] font-semibold bg-surface border border-border2 rounded px-1 flex-shrink-0">
          {isMac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>

      <div className="flex items-center gap-3 flex-shrink-0 ml-auto">
        {user?.role === 'admin' && (
          <button
            type="button"
            onClick={() => openBulkActivity()}
            aria-label="Bulk Activity"
            title="Bulk Activity"
            className="text-text3 hover:text-text hover:bg-surface2 rounded-lg p-2 transition-colors"
          >
            <ListChecks className="w-[18px] h-[18px]" />
          </button>
        )}
        <span className="hidden sm:inline text-[11px] text-text3">
          {istTime} IST
        </span>
        <span className="hidden sm:inline text-[11px] text-text3 border-l border-border pl-3">
          {utcTime} UTC
        </span>
        <div className="flex items-center gap-1 border-l border-border pl-3">
          <NotificationBell />
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}
