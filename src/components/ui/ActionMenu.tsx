import { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';

export interface ActionMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  hidden?: boolean;
}

/** Overflow menu for secondary row actions -- click the ⋯ button to reveal a dropdown. */
export default function ActionMenu({ items }: { items: ActionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visibleItems = items.filter((item) => !item.hidden);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (visibleItems.length === 0) return null;

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        className="text-text3 hover:text-text hover:bg-surface2 rounded p-1"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="More actions"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div
          // whitespace-normal resets any `white-space: nowrap` inherited from an
          // ancestor cell (e.g. a table column styled `whitespace-nowrap`, which
          // ActionMenu is often placed inside) -- that inherited nowrap otherwise
          // suppresses the wrap between these buttons, forcing them onto one line
          // so a second/third item overflows past the menu's right edge instead of
          // stacking below the first.
          className="absolute right-0 z-50 mt-1 min-w-[140px] whitespace-normal bg-surface border border-border rounded-lg shadow-lg py-1"
          onClick={(e) => e.stopPropagation()}
        >
          {visibleItems.map((item) => (
            <button
              key={item.label}
              className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-surface2 ${
                item.danger ? 'text-danger' : 'text-text'
              }`}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
