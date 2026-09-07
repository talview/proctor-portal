import { ReactNode, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
};

let openModalCount = 0;

export default function Modal({ isOpen, onClose, title, children, size = 'md' }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(dialogRef, isOpen);

  useEffect(() => {
    if (isOpen) {
      if (openModalCount === 0) {
        document.body.style.overflow = 'hidden';
      }
      openModalCount += 1;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (isOpen) {
        openModalCount = Math.max(0, openModalCount - 1);
        if (openModalCount === 0) {
          document.body.style.overflow = '';
        }
      }
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[1000] flex items-center justify-center p-5"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`
          bg-surface border border-border rounded-2xl
          w-full ${sizeClasses[size]} max-h-[90vh]
          overflow-y-auto shadow-2xl outline-none
        `}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border">
          <h3 id={titleId} className="text-base font-bold text-text">{title}</h3>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            className="text-text3 hover:text-text hover:bg-surface2 rounded-md p-1.5 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-6">{children}</div>
      </div>
    </div>
  );
}
