import { useEffect, useRef, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useUIStore, type ThemePreference } from '@/stores/ui';

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Tri-state light/dark/system picker -- "system" isn't just the default value,
 * it's live: useThemeSync re-checks the OS preference on every change while
 * it's selected, rather than freezing it at whatever it resolved to on click. */
export default function ThemeToggle() {
  const { theme, setTheme } = useUIStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const ActiveIcon = OPTIONS.find((o) => o.value === theme)?.icon ?? Monitor;

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="p-2 text-text3 hover:text-text hover:bg-surface2 rounded-lg transition-colors"
        title={`Theme: ${theme}`}
      >
        <ActiveIcon className="w-[18px] h-[18px]" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 min-w-[140px] bg-surface border border-border rounded-lg shadow-lg py-1">
          {OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = theme === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => {
                  setTheme(opt.value);
                  setOpen(false);
                }}
                className={`flex items-center gap-2.5 w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  active ? 'text-accent font-semibold bg-accent/10' : 'text-text hover:bg-surface2'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
