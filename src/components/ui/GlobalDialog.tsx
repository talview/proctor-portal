import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { useFocusTrap } from '@/hooks/useFocusTrap';

type DialogRequest =
  | { kind: 'alert'; message: string; title?: string; tone?: 'info' | 'success' | 'error'; resolve: () => void }
  | { kind: 'confirm'; message: string; title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; resolve: (ok: boolean) => void };

let dispatch: ((req: DialogRequest) => void) | null = null;

/**
 * Themed replacements for window.alert()/confirm() -- centered, overlay-blurred,
 * matching the app's Modal styling instead of the browser's native chrome dialog.
 * Mount <GlobalDialogHost /> once near the app root; call showAlert/showConfirm
 * from anywhere, same call sites as alert()/confirm() (confirm is async here).
 */
export function showAlert(message: string, opts?: { title?: string; tone?: 'info' | 'success' | 'error' }) {
  return new Promise<void>((resolve) => {
    dispatch?.({ kind: 'alert', message, title: opts?.title, tone: opts?.tone, resolve });
  });
}

export function showConfirm(
  message: string,
  opts?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
) {
  return new Promise<boolean>((resolve) => {
    dispatch?.({
      kind: 'confirm',
      message,
      title: opts?.title,
      confirmLabel: opts?.confirmLabel,
      cancelLabel: opts?.cancelLabel,
      danger: opts?.danger,
      resolve,
    });
  });
}

export default function GlobalDialogHost() {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const messageId = useId();
  useFocusTrap(dialogRef, !!request);

  useEffect(() => {
    dispatch = setRequest;
    return () => {
      dispatch = null;
    };
  }, []);

  useEffect(() => {
    if (!request) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (request.kind === 'alert') request.resolve();
        else request.resolve(false);
        setRequest(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [request]);

  if (!request) return null;

  const icon =
    request.kind === 'alert' && request.tone === 'success' ? (
      <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
    ) : request.kind === 'alert' && request.tone === 'error' ? (
      <AlertTriangle className="w-5 h-5 text-danger flex-shrink-0" />
    ) : request.kind === 'confirm' && request.danger ? (
      <AlertTriangle className="w-5 h-5 text-danger flex-shrink-0" />
    ) : (
      <Info className="w-5 h-5 text-accent flex-shrink-0" />
    );

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[1200] flex items-center justify-center p-5">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-describedby={messageId}
        tabIndex={-1}
        className="bg-surface border border-border rounded-2xl w-full max-w-sm shadow-2xl outline-none"
      >
        <div className="px-6 py-5">
          {request.title && <h3 className="text-sm font-bold text-text mb-2">{request.title}</h3>}
          <div className="flex items-start gap-2.5">
            {icon}
            <p id={messageId} className="text-sm text-text2 leading-relaxed">{request.message}</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
          {request.kind === 'confirm' && (
            <button
              className="text-xs font-semibold text-text3 hover:text-text px-3 py-2"
              onClick={() => {
                request.resolve(false);
                setRequest(null);
              }}
            >
              {request.cancelLabel || 'Cancel'}
            </button>
          )}
          <button
            className={`text-xs font-semibold px-4 py-2 rounded-lg text-white ${
              request.kind === 'confirm' && request.danger
                ? 'bg-danger hover:bg-danger/90'
                : 'bg-accent hover:bg-accent/90'
            }`}
            onClick={() => {
              if (request.kind === 'alert') request.resolve();
              else request.resolve(true);
              setRequest(null);
            }}
          >
            {request.kind === 'confirm' ? request.confirmLabel || 'Confirm' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
