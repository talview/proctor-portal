import type { ComponentType } from 'react';

export interface CompactSegmentedTabOption {
  label: string;
  value: string | number;
  icon?: ComponentType<{ className?: string }>;
}

/** A sub-tab nested inside a primary in-page tab (e.g. Individual Assign/Multi
 * Assign inside Assessment, inside Certification's own top-level tabs).
 * Deliberately lighter-weight than UnderlineTabs (primary in-page tabs, which has
 * no container at all): a compact pill container where the active item gets a
 * white/light fill with blue text instead of a solid color, so it reads as a step
 * down in visual weight rather than a repeat of it. */
export default function CompactSegmentedTabs({
  options,
  value,
  onChange,
}: {
  options: CompactSegmentedTabOption[];
  value: string | number;
  onChange: (value: any) => void;
}) {
  return (
    <div role="tablist" className="inline-flex items-center gap-0.5 rounded-md border border-border bg-surface2 p-0.5 max-w-full overflow-x-auto">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold transition-colors flex-shrink-0 whitespace-nowrap ${
              active ? 'bg-surface text-accent shadow-sm' : 'text-text3 hover:text-text2'
            }`}
          >
            {Icon && <Icon className="w-3.5 h-3.5" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
