import { useEffect, useRef, useState } from 'react';
import { Filter as FilterIcon, ChevronRight, X } from 'lucide-react';
import Select from './Select';

export interface FilterFieldOption {
  value: string;
  label: string;
}

export interface FilterFieldDef {
  key: string;
  label: string;
  type?: 'select' | 'date';
  /** Required when type is 'select' (the default). */
  options?: FilterFieldOption[];
}

interface FilterBuilderProps {
  fields: FilterFieldDef[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

/** Just the "+ Add Filter" trigger + its field/value popover -- split out from the
 * chips themselves (see FilterChips below) so a caller can place the trigger inline
 * with other controls (search, quick-filter buttons) on one row, and the applied
 * chips on their own row underneath. Putting both in one flex row meant a newly
 * added chip could wrap the row and shove whatever sat to its right (e.g. an
 * Export button) down awkwardly. */
export function FilterTrigger({ fields, values, onChange }: FilterBuilderProps) {
  const [open, setOpen] = useState(false);
  const [pickingField, setPickingField] = useState<FilterFieldDef | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setPickingField(null);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // A field with an active value isn't offered again here -- editing an applied
  // chip's value is remove-then-re-add, keeping this control small.
  const availableFields = fields.filter((f) => !values[f.key]);

  const applyDraft = () => {
    if (!pickingField || !draftValue) return;
    onChange(pickingField.key, draftValue);
    setPickingField(null);
    setDraftValue('');
    setOpen(false);
  };

  if (availableFields.length === 0) return null;

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setPickingField(null);
          setDraftValue('');
        }}
        className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-2.5 py-1.5 rounded-lg border border-dashed border-border2 text-text2 hover:border-accent hover:text-accent transition-colors whitespace-nowrap"
      >
        <FilterIcon className="w-3.5 h-3.5" />
        Add Filter
      </button>
      {open && (
        <div className="absolute left-0 z-50 mt-1 w-56 bg-surface border border-border rounded-lg shadow-lg overflow-hidden">
          {!pickingField ? (
            <div className="py-1">
              {availableFields.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setPickingField(f)}
                  className="w-full flex items-center justify-between px-3 py-2 text-[12.5px] text-text2 hover:bg-surface2 transition-colors"
                >
                  {f.label}
                  <ChevronRight className="w-3 h-3 text-text3" />
                </button>
              ))}
            </div>
          ) : (
            <div className="p-2.5">
              <div className="text-[11px] font-semibold text-text3 uppercase tracking-wide mb-1.5">
                {pickingField.label}
              </div>
              {pickingField.type === 'date' ? (
                <input
                  type="date"
                  autoFocus
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
                  className="w-full bg-surface2 border border-border rounded-md px-3 py-2 text-sm text-text outline-none focus:border-accent transition-colors"
                />
              ) : (
                <Select
                  autoFocus
                  options={[{ value: '', label: 'Select...' }, ...(pickingField.options || [])]}
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
                />
              )}
              <div className="flex items-center justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setPickingField(null)}
                  className="text-[11.5px] text-text3 hover:text-text px-2 py-1"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={!draftValue}
                  onClick={applyDraft}
                  className="text-[11.5px] font-semibold text-white bg-accent disabled:opacity-40 disabled:cursor-not-allowed px-2.5 py-1 rounded-md hover:bg-accent/90 transition-colors"
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The applied-filter chips row -- rendered separately from FilterTrigger (above)
 * so it can live on its own line below the main filter row without disturbing that
 * row's layout as chips are added/removed. Renders nothing when no field is active,
 * so a caller can conditionally reserve space only when there's something to show. */
export function FilterChips({ fields, values, onChange }: FilterBuilderProps) {
  const activeChips = fields.filter((f) => values[f.key]);
  if (activeChips.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {activeChips.map((f) => {
        const label = f.options?.find((o) => o.value === values[f.key])?.label ?? values[f.key];
        return (
          <span
            key={f.key}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium pl-2.5 pr-1.5 py-1.5 rounded-lg border border-border bg-surface2 text-text2"
          >
            <span className="text-text3">{f.label}:</span> {label}
            <button
              type="button"
              onClick={() => onChange(f.key, '')}
              className="text-text3 hover:text-text rounded-full p-0.5 hover:bg-surface transition-colors"
              aria-label={`Remove ${f.label} filter`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** Combined trigger + chips, kept for callers that don't need the two-row split
 * (e.g. a filter row with nothing else fighting for horizontal space). */
export default function FilterBuilder(props: FilterBuilderProps) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <FilterChips {...props} />
      <FilterTrigger {...props} />
    </div>
  );
}
