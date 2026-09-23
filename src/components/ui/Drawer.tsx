import { ReactNode, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** ReactNode, not just a string, so a caller can put an avatar next to the title
   * (e.g. ProctorDrawer's header) -- everything else about the header stays plain. */
  title: ReactNode;
  subtitle?: ReactNode;
  headerExtra?: ReactNode;
  children: ReactNode;
  /** Tailwind width classes for the panel. Defaults to this component's original
   * width (BulkActivityDrawer's recipient table genuinely needs it); pass a
   * narrower one for content that doesn't, like ProctorDrawer. */
  widthClassName?: string;
}

/** A master-detail side panel, not a modal: no backdrop, and clicking elsewhere
 * on the page (a different table row, a filter) doesn't close it -- the caller
 * just swaps what's passed as `children`/`title` while `isOpen` stays true, so
 * switching rows updates the panel's content in place instead of closing and
 * reopening it. Only the X button and Escape close it. */
export default function Drawer({
  isOpen,
  onClose,
  title,
  subtitle,
  headerExtra,
  children,
  widthClassName = 'w-full sm:w-[480px] lg:w-[560px]',
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Non-modal (see aria-modal="false" below): move focus in on open so keyboard/
  // screen-reader users land in the panel, but -- unlike Modal/GlobalDialog's
  // useFocusTrap -- Tab is free to leave it, since the underlying page stays
  // genuinely interactive while this is open.
  useEffect(() => {
    if (!isOpen) return;
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      className={`drawer-panel fixed top-0 right-0 h-screen ${widthClassName} bg-surface border-l border-border shadow-2xl z-[900] flex flex-col outline-none`}
    >
      <div className="flex items-start justify-between gap-3 px-6 py-5 border-b border-border flex-shrink-0">
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-bold text-text truncate">{title}</h2>
          {subtitle && <p className="text-xs text-text3 mt-0.5 truncate">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {headerExtra}
          <button
            type="button"
            aria-label="Close panel"
            onClick={onClose}
            className="text-text3 hover:text-text hover:bg-surface2 rounded-md p-1.5 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">{children}</div>

      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .drawer-panel {
            animation: drawer-in 0.18s ease-out;
          }
          @keyframes drawer-in {
            from { transform: translateX(16px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
        }
      `}</style>
    </div>
  );
}
