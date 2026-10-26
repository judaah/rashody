// Когда ходить к посреднику: при запуске, раз в минуту, когда приложение снова на экране,
// когда появилась сеть и через 3 секунды после моих правок. Одновременно — только один обмен.

import { useEffect, useRef, useState } from 'preact/hooks';
import { db } from '../db/db';
import { httpTransport, syncOnce, SyncError, type SyncState, type Transport } from '../db/sync';
import { useLive } from '../lib/hooks';

/** Адрес посредника задаётся при сборке (VITE_SYNC_URL). Без него обмен выключен. */
export const SYNC_URL: string | undefined = import.meta.env.VITE_SYNC_URL || undefined;

const transport: Transport | null = SYNC_URL ? httpTransport(SYNC_URL) : null;

export function relay(): Transport {
  if (!transport) throw new SyncError('Обмен с партнёром не настроен в этой сборке приложения');
  return transport;
}

export interface RunnerStatus {
  running: boolean;
  error: string | null;
  last: SyncState | null;
}

let status: RunnerStatus = { running: false, error: null, last: null };
const listeners = new Set<(s: RunnerStatus) => void>();
const emit = (patch: Partial<RunnerStatus>) => {
  status = { ...status, ...patch };
  listeners.forEach((l) => l(status));
};

let inflight: Promise<SyncState | null> | null = null;

/** Один обмен; если обмен уже идёт — ждём его же. Ошибки не бросает, а кладёт в статус. */
export function runSync(): Promise<SyncState | null> {
  if (!transport) return Promise.resolve(null);
  if (!inflight) {
    emit({ running: true });
    inflight = syncOnce(transport)
      .then((last) => {
        emit({ running: false, error: null, last });
        return last;
      })
      .catch((err: unknown) => {
        const offline = err instanceof TypeError || !navigator.onLine;
        emit({ running: false, error: offline ? 'Нет связи с посредником — обменяемся, когда появится сеть' : String((err as Error).message ?? err) });
        return null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useSyncStatus(): RunnerStatus {
  const [s, setS] = useState(status);
  useEffect(() => {
    listeners.add(setS);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

const EVERY_MS = 60_000;
const AFTER_EDIT_MS = 3_000;

/** Подключается один раз в App. Ничего не делает, пока пара не создана. */
export function useSyncScheduler(paired: boolean): void {
  // Отпечаток моих данных: число трат и сумма их времени правки меняются при добавлении,
  // правке и удалении; категории — целиком. Что именно поменялось, разберётся syncOnce.
  const mine = useLive(async () => {
    const [expenses, cats] = await Promise.all([db.expenses.toArray(), db.categories.toArray()]);
    const touched = expenses.reduce((s, e) => s + e.updatedAt, 0);
    return `${expenses.length}|${touched}|${JSON.stringify(cats.map((c) => [c.id, c.name, c.emoji, c.color, c.archived, c.order]))}`;
  }, []);
  const first = useRef(true);

  useEffect(() => {
    if (!paired || !transport) return;
    void runSync();
    const timer = setInterval(() => void runSync(), EVERY_MS);
    const onVisible = () => document.visibilityState === 'visible' && void runSync();
    const onOnline = () => void runSync();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [paired]);

  useEffect(() => {
    if (!paired || !transport || mine === undefined) return;
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => void runSync(), AFTER_EDIT_MS);
    return () => clearTimeout(t);
  }, [mine, paired]);
}
