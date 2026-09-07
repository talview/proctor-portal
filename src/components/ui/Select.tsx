import { SelectHTMLAttributes, forwardRef } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
  id?: string;
  /** Class for the outer wrapper div. Defaults to full-width for form usage;
   * pass e.g. "w-auto" or "min-w-[160px]" in filter bars to avoid stretching. */
  wrapperClassName?: string;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, className = '', wrapperClassName = 'w-full', id, ...props }, ref) => {
    const selectId = id || (label ? `select-${label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}` : undefined);
    return (
      <div className={wrapperClassName}>
        {label && (
          <label htmlFor={selectId} className="block text-xs font-semibold text-text2 uppercase tracking-wide mb-1.5">
            {label}
            {props.required && <span className="text-danger ml-0.5">*</span>}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={`
            w-full bg-surface2 border border-border rounded-md px-3.5 py-2.5
            text-sm text-text
            outline-none focus:border-accent transition-colors
            disabled:opacity-50 disabled:cursor-not-allowed
            ${error ? 'border-danger' : ''}
            ${className}
          `}
          aria-invalid={!!error}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {error && (
          <p className="text-danger text-[11px] mt-1">{error}</p>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';

export default Select;
