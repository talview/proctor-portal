import { useEffect } from 'react';
import { useUIStore } from '@/stores/ui';

/** Applies the resolved theme (the user's explicit light/dark choice, or the OS
 * preference when set to "system") to <html> as Tailwind's `dark:` class hook.
 * Re-evaluates on every OS-level scheme change while the choice is "system" --
 * a laptop that flips to dark at sunset shouldn't need a manual toggle to catch up. */
export function useThemeSync() {
  const theme = useUIStore((s) => s.theme);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      const isDark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', isDark);
    };

    apply();

    if (theme === 'system') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
  }, [theme]);
}
