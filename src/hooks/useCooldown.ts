import { useEffect, useRef, useState } from 'react';

/**
 * Ticks a remaining-seconds countdown down to 0 once a second. Used to make a
 * server-enforced cooldown (e.g. OTP resend) visible in the UI as a disabled
 * button + live countdown, instead of the user only discovering it exists when a
 * click gets rejected with an error.
 */
export function useCooldown() {
  const [remaining, setRemaining] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = (seconds: number) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setRemaining(Math.ceil(seconds));
    intervalRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  useEffect(() => () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, []);

  return { remaining, start };
}

/** Pulls the "(27s)" the OTP cooldown error message ends with, so a rejected click
 * (e.g. a second tab, or a click that raced the button's disabled state) can
 * re-sync the visible countdown to the server's real remaining time instead of
 * just showing a static error. */
export function parseCooldownSeconds(message: string): number | null {
  const match = message.match(/\((\d+)s\)/);
  return match ? parseInt(match[1], 10) : null;
}
