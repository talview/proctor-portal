import { X } from 'lucide-react';

/** Small "Clear" affordance shown next to a filter bar once any filter is active. */
export default function ClearFiltersButton({ onClick, show }: { onClick: () => void; show: boolean }) {
  if (!show) return null;
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 text-xs font-semibold text-text3 hover:text-text px-2 py-1.5"
    >
      <X className="w-3.5 h-3.5" /> Clear
    </button>
  );
}
