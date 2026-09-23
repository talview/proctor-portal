import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/services/supabase';

const RESYNC_INTERVAL_MS = 5 * 60_000;
const TICK_MS = 30_000;

/** The topbar clock and the notification panel's relative timestamps read this
 * instead of `new Date()` directly -- a machine's local system clock can
 * silently drift by minutes (the report that led to this: the topbar read a
 * minute off from the user's own machine). Syncs against the `server-time`
 * edge function (a real network clock, Supabase's own, not this machine's)
 * once on mount and every 5 minutes after to bound drift across a long
 * session; a failed sync (offline, blocked) just keeps the last known offset
 * (0 initially) rather than breaking the clock. Compute cost is one stateless
 * edge invocation with no DB access every 5 minutes per open tab -- cheaper
 * than a single typical query. */
export function useNetworkTime() {
  const [offsetMs, setOffsetMs] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const start = Date.now();
        const { data, error } = await supabase.functions.invoke<{ now: string }>('server-time');
        if (error || !data?.now || cancelled) return;
        // Assume the server's clock was read roughly halfway through the
        // round trip -- close enough for display purposes, not NTP-grade.
        const latency = (Date.now() - start) / 2;
        setOffsetMs(new Date(data.now).getTime() + latency - Date.now());
      } catch {
        // offline or blocked -- keep whatever offset we already have
      }
    };
    sync();
    const resync = setInterval(sync, RESYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(resync);
    };
  }, []);

  return useMemo(() => new Date(Date.now() + offsetMs), [offsetMs, tick]);
}
