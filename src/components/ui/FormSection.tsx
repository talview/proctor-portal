import type { ReactNode } from 'react';

/** One shared section-header style for grouping fields inside a form -- this
 * app had at least 4 slightly different variants (font-weight, tracking,
 * bottom margin) before this existed. Renders just the heading (optionally
 * with a trailing action, e.g. an "+ Add" button); wrap the fields themselves
 * below it same as before. */
export default function FormSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className={`flex items-center justify-between ${action ? 'mb-3' : 'mb-4'}`}>
        <h3 className="text-sm font-semibold text-text uppercase tracking-wide">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}
