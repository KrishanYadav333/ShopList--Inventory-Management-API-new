import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Icon } from './icons';

export interface ToastOptions {
  kind?: 'success' | 'error' | 'info';
  text: string;
  /** Shown as a button, e.g. Undo. */
  action?: { label: string; run: () => void };
  ms?: number;
}
interface Item extends ToastOptions {
  id: number;
}

const Ctx = createContext<(t: ToastOptions) => void>(() => {});
export const useToast = () => useContext(Ctx);

let seq = 0;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: ToastOptions) => {
      const id = ++seq;
      setItems((l) => [...l.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.ms ?? (t.action ? 10_000 : 4_000));
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind ?? 'info'}`}>
            <Icon name={t.kind === 'error' ? 'alert' : 'check'} />
            <span className="toast-text">{t.text}</span>
            {t.action && (
              <button className="toast-action" onClick={() => { t.action!.run(); dismiss(t.id); }}>
                <Icon name="undo" size={14} /> {t.action.label}
              </button>
            )}
            <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
