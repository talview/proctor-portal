import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemePreference = 'light' | 'dark' | 'system';

interface UIState {
  /** The user's *choice*, not the resolved theme -- 'system' means "follow the
   * OS," which ThemeProvider re-evaluates on every OS-level change rather than
   * freezing it at whatever it happened to be on the last toggle click. */
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  /** Desktop-only manual collapse (the sidebar also auto-narrows to the same
   * icon-only rail below the md breakpoint regardless of this -- that's a
   * screen-size fallback, this is the user's own persisted choice). A real
   * preference like theme, so it's persisted the same way. */
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  /** One Bulk Activity drawer, mounted once in MainLayout instead of separately by
   * every page that has a "Bulk Activity" entry point (ProctorsPage,
   * InterviewSelectsPage, AuditLogPage, and now the notification bell) -- so its job
   * list stays warm across navigation instead of refetching from scratch on every
   * open, and so the bell (outside all of those pages' component trees) has
   * something to open. Not persisted -- session-transient, not a preference. */
  bulkActivityOpen: boolean;
  bulkActivityJobId: string | null;
  openBulkActivity: (jobId?: string | null) => void;
  closeBulkActivity: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      theme: 'system',
      setTheme: (theme) => set({ theme }),
      sidebarCollapsed: false,
      toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      bulkActivityOpen: false,
      bulkActivityJobId: null,
      openBulkActivity: (jobId) => set({ bulkActivityOpen: true, bulkActivityJobId: jobId ?? null }),
      closeBulkActivity: () => set({ bulkActivityOpen: false }),
    }),
    {
      name: 'proctor-portal-ui',
      partialize: (state) => ({ theme: state.theme, sidebarCollapsed: state.sidebarCollapsed }),
    }
  )
);
