import { InputHTMLAttributes, forwardRef } from 'react';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  error?: string;
  size?: 'sm' | 'md';
  id?: string;
  /** Class for the outer wrapper div. Defaults to full-width for form usage;
   * pass e.g. "w-auto" or "flex-1 min-w-[200px]" in filter bars to avoid stretching. */
  wrapperClassName?: string;
}

const sizeClasses = {
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-3.5 py-2.5 text-sm',
};

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, size = 'md', className = '', wrapperClassName = 'w-full', id, ...props }, ref) => {
    const inputId = id || (label ? `input-${label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}` : undefined);
    return (
      <div className={wrapperClassName}>
        {label && (
          <label htmlFor={inputId} className="block text-xs font-semibold text-text2 uppercase tracking-wide mb-1.5">
            {label}
            {props.required && <span className="text-danger ml-0.5">*</span>}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`
            w-full bg-surface2 border border-border rounded-md
            text-text placeholder-text3
            outline-none focus:border-accent transition-colors
            disabled:opacity-50 disabled:cursor-not-allowed
            ${sizeClasses[size]}
            ${error ? 'border-danger' : ''}
            ${className}
          `}
          aria-invalid={!!error}
          aria-describedby={error && inputId ? `${inputId}-error` : undefined}
          {...props}
        />
        {error && (
          <p id={inputId ? `${inputId}-error` : undefined} className="text-danger text-[11px] mt-1">{error}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export default Input;
