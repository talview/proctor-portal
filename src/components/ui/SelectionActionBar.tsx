import { ReactNode, ComponentType } from 'react';
import { X } from 'lucide-react';

interface SelectionActionBarProps {
  count: number;
  onClear: () => void;
  children: ReactNode;
}

/** Floating pill shown while rows are selected -- deliberately a dark, high-contrast
 * chip (unlike the rest of this app's light surfaces) so it reads as a temporary
 * overlay on top of the table, not another panel of the page. Shared by ProctorsPage
 * and InterviewSelectsPage, which had this as identical duplicated markup before.
 *
 * The background is a literal dark color, not the semantic `bg-text` token --
 * `bg-text` flips to near-white in dark mode (it's meant for body text, not chrome),
 * which used to render this pill as near-white-on-near-white since every child here
 * stays hardcoded white. Matches Sidebar's own "deliberately not a theme token"
 * dark chrome, so it stays this same dark pill regardless of app theme. */
export default function SelectionActionBar({ count, onClear, children }: SelectionActionBarProps) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1100] bg-[#1A1730] rounded-full shadow-2xl pl-1.5 pr-2 py-1.5 flex items-center gap-1">
      <div className="flex items-center gap-2 pl-1 pr-3">
        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-accent5 text-white text-[11px] font-bold flex-shrink-0">
          {count}
        </span>
        <span className="text-white/90 text-[13px] font-medium whitespace-nowrap">Selected</span>
      </div>
      <div className="w-px h-5 bg-white/15 flex-shrink-0" />
      <div className="flex items-center gap-0.5">{children}</div>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        className="ml-1 w-7 h-7 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

interface SelectionActionProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Tailwind text-color class for the icon -- e.g. a green check for "Verify", an
   * amber bolt for "Activate". Omit for a neutral action (e.g. "Send Docs"). */
  iconClassName?: string;
}

export function SelectionAction({ icon: Icon, label, onClick, disabled, iconClassName }: SelectionActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-white/90 text-[13px] font-medium hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
    >
      <Icon className={`w-4 h-4 flex-shrink-0 ${iconClassName || 'text-white/70'}`} />
      {label}
    </button>
  );
}
