import { HelpCircle, type LucideIcon } from 'lucide-react';

export interface StatusLegendItem {
  Icon: LucideIcon;
  label: string;
  desc: string;
  className: string;
}

/** Hover trigger spelling out an icon-only column's vocabulary -- a single glyph
 * in an 11px table cell isn't self-explanatory, so this shows it once, in place,
 * instead of relying on a README or tribal knowledge. Shared by every icon-only
 * status column (dispatch, demo/assessment, ...) so they all look and behave the
 * same way. */
export default function StatusLegend({ title, items }: { title: string; items: StatusLegendItem[] }) {
  return (
    <span className="relative inline-flex group normal-case font-normal tracking-normal">
      <HelpCircle className="w-3 h-3 text-text3 cursor-default" />
      <span className="absolute hidden group-hover:block top-full left-1/2 -translate-x-1/2 mt-1.5 w-52 bg-surface border border-border rounded-lg shadow-lg p-2.5 z-30">
        <span className="block text-[10px] font-bold uppercase tracking-wide text-text3 mb-1.5">{title}</span>
        {items.map(({ Icon, label, desc, className }) => (
          <span key={label} className="flex items-center gap-2 py-1">
            <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${className}`} />
            <span>
              <span className="block text-[11px] font-semibold text-text leading-tight">{label}</span>
              <span className="block text-[9.5px] text-text3 leading-tight">{desc}</span>
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}
