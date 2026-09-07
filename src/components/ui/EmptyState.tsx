import type { LucideIcon } from 'lucide-react';

/**
 * One shared "no data" pattern (icon + heading + optional subtext) -- this app
 * had at least 4 different hand-rolled variants (some with no heading, some
 * with no icon, different icon sizes) before this existed. `compact` drops the
 * fixed height for use inside a table cell or a small card rather than a
 * full-page panel.
 */
export default function EmptyState({
  icon: Icon,
  title,
  message,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  message?: string;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center gap-1 ${compact ? 'py-8' : 'h-64'}`}>
      {Icon && <Icon className="w-10 h-10 text-text3 mb-1" />}
      <h3 className="text-base font-semibold text-text">{title}</h3>
      {message && <p className="text-text3 text-sm">{message}</p>}
    </div>
  );
}
