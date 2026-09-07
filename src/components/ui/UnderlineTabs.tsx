import type { ComponentType } from 'react';

export interface UnderlineTabOption {
  label: string;
  value: string | number;
  icon?: ComponentType<{ className?: string }>;
}

/** Primary in-page tab control -- underline style, one tier below the page
 * switcher (SegmentedTabs). Same API as SegmentedTabs, deliberately a
 * different look so the two navigation tiers never appear to be the same
 * control. */
export default function UnderlineTabs({
  options,
  value,
  onChange,
}: {
  options: UnderlineTabOption[];
  value: string | number;
  onChange: (value: any) => void;
}) {
  return (
    <div role="tablist" className="flex gap-2 border-b border-border overflow-x-auto">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px flex-shrink-0 whitespace-nowrap ${
              active ? 'text-accent border-accent' : 'text-text3 border-transparent hover:text-text'
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
