import type { ComponentType } from 'react';

export interface SegmentedTabOption {
  label: string;
  value: string | number;
  icon?: ComponentType<{ className?: string }>;
}

/** Page-switcher control -- used by PageSwitcher to move between the pages of
 * the current sidebar category. Solid pill/segmented style, deliberately not
 * the underline-tab look used one tier down for primary in-page tabs
 * (UnderlineTabs), so the two navigation tiers never look like the same
 * control. */
export default function SegmentedTabs({
  options,
  value,
  onChange,
}: {
  options: SegmentedTabOption[];
  value: string | number;
  onChange: (value: any) => void;
}) {
  return (
    <div role="tablist" className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface2 p-1 max-w-full overflow-x-auto">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold transition-colors flex-shrink-0 whitespace-nowrap ${
              active ? 'bg-accent text-white shadow-sm' : 'text-text2 hover:text-text hover:bg-surface'
            }`}
          >
            {Icon && <Icon className="w-4 h-4" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
