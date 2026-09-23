import { useCallback, useState } from 'react';
import { useAuthStore } from '@/stores/auth';

function storageKey(username?: string | null): string {
  return `notif-read:${username || 'anon'}`;
}

function loadReadKeys(username?: string | null): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(username));
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

/** No notifications table exists in the backend -- every entry the bell shows
 * is a live-derived reminder recomputed on every load (see
 * useUpcomingReminders), not a stored row, so there is nowhere server-side to
 * persist "read." This keeps a per-browser read-state set in localStorage
 * instead, keyed by the same identity used to render each entry (entryKey).
 * Good enough for "the dot goes away when I open it" and "mark all as read
 * sticks across a reload" -- but it's local to this device/browser, not a
 * real synced read receipt, and a private window or cleared site data starts
 * fresh. */
export function useNotificationReadState() {
  const { user } = useAuthStore();
  const [readKeys, setReadKeys] = useState<Set<string>>(() => loadReadKeys(user?.username));

  const persist = useCallback(
    (next: Set<string>) => {
      setReadKeys(next);
      try {
        localStorage.setItem(storageKey(user?.username), JSON.stringify(Array.from(next)));
      } catch {
        // private browsing / storage disabled -- read-state just won't persist
      }
    },
    [user?.username]
  );

  const markRead = useCallback((key: string) => persist(new Set(readKeys).add(key)), [readKeys, persist]);

  const markAllRead = useCallback((keys: string[]) => persist(new Set([...readKeys, ...keys])), [readKeys, persist]);

  const isRead = useCallback((key: string) => readKeys.has(key), [readKeys]);

  return { isRead, markRead, markAllRead };
}
