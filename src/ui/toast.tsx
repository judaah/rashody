import { useEffect, useState } from 'preact/hooks';

interface Toast {
  id: number;
  text: string;
  action?: string;
  onAction?: () => void;
}

const TOAST_MS = 5000;
let current: Toast | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(t: Toast | null) => void>();

function emit(t: Toast | null) {
  current = t;
  listeners.forEach((l) => l(t));
}

/** Показывает один тост (новый заменяет старый) на 5 секунд, с необязательной кнопкой. */
export function showToast(text: string, opts: { action?: string; onAction?: () => void } = {}) {
  clearTimeout(timer);
  const toast = { id: ++seq, text, ...opts };
  emit(toast);
  timer = setTimeout(() => current?.id === toast.id && emit(null), TOAST_MS);
}

export function Toasts() {
  const [toast, setToast] = useState<Toast | null>(current);
  useEffect(() => {
    listeners.add(setToast);
    return () => void listeners.delete(setToast);
  }, []);
  if (!toast) return null;
  return (
    <div class="toast" role="status" key={toast.id}>
      <span class="toast-text">{toast.text}</span>
      {toast.action && (
        <button
          class="toast-action"
          onClick={() => {
            emit(null);
            toast.onAction?.();
          }}
        >
          {toast.action}
        </button>
      )}
    </div>
  );
}
