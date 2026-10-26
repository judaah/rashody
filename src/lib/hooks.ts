import { useEffect, useState } from 'preact/hooks';
import { liveQuery } from 'dexie';
import { today } from './dates';

/**
 * Подписка на запрос к IndexedDB: компонент перерисуется сам, когда данные
 * в затронутых таблицах изменятся. undefined — пока первый ответ не пришёл.
 */
export function useLive<T>(query: () => Promise<T> | T, deps: unknown[]): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({
      next: setValue,
      error: (err) => console.error('liveQuery', err),
    });
    return () => sub.unsubscribe();
  }, deps);
  return value;
}

/** Текущая дата 'YYYY-MM-DD', обновляется после полуночи и при возврате в приложение. */
export function useToday(): string {
  const [value, setValue] = useState(() => today());
  useEffect(() => {
    const refresh = () => setValue(today());
    const timer = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  return value;
}
