/**
 * lib/toast-bus.ts — Minimal event bus for firing toasts from non-React modules (api/client).
 * Components listen via useEffect; api/client fires without importing React context.
 */

type ToastListener = (msg: string, variant: 'error' | 'success') => void;

let _listener: ToastListener | null = null;

export function registerToastListener(fn: ToastListener) {
  _listener = fn;
}

export function toastError(msg: string) {
  _listener?.(msg, 'error');
}

export function toastSuccess(msg: string) {
  _listener?.(msg, 'success');
}
