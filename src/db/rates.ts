import { db, type RateSource } from './db';
import { fetchCbrRates, toRub, type FetchLike, type ParsedRates } from '../lib/rates';
import { RUB } from '../lib/money';
import { today } from '../lib/dates';

export interface RateInfo {
  /** Рублей за 1 единицу валюты. */
  rate: number;
  source: RateSource;
  /** Дата, на которую ЦБ установил этот курс. */
  date: string;
}

// Один запрос на дату за сеанс: в выходные курса на сам день нет, и без этого
// мы бы ходили в ЦБ при каждом открытии окна ввода.
const requested = new Map<string, Promise<ParsedRates | null>>();

export async function saveRates(parsed: ParsedRates): Promise<void> {
  await db.rates.bulkPut(parsed.rates.map((r) => ({ date: parsed.date, currency: r.currency, rate: r.rate })));
}

function loadFromCbr(date: string, fetchImpl?: FetchLike): Promise<ParsedRates | null> {
  let pending = requested.get(date);
  if (!pending) {
    pending = fetchCbrRates(date, fetchImpl).then(async (parsed) => {
      if (parsed) await saveRates(parsed);
      return parsed;
    });
    // Ошибку сети не запоминаем — в следующий раз попробуем снова.
    pending.catch(() => requested.delete(date));
    requested.set(date, pending);
  }
  return pending;
}

/** Последний сохранённый курс валюты на дату или раньше. */
export async function localRate(currency: string, date: string) {
  const rows = await db.rates.where('currency').equals(currency).toArray();
  return rows.filter((r) => r.date <= date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
}

/**
 * Курс для траты: сохранённый на эту дату → ЦБ из интернета → последний сохранённый
 * («stale», пересчитается позже). null — курса нет совсем, нужен ручной ввод.
 */
export async function resolveRate(
  currency: string,
  date: string,
  { online = navigator.onLine, fetchImpl }: { online?: boolean; fetchImpl?: FetchLike } = {},
): Promise<RateInfo | null> {
  if (currency === RUB) return { rate: 1, source: 'cbr', date };
  const local = await localRate(currency, date);
  if (local?.date === date) return { rate: local.rate, source: 'cbr', date: local.date };
  if (online) {
    try {
      const parsed = await loadFromCbr(date, fetchImpl);
      const found = parsed?.rates.find((r) => r.currency === currency);
      if (parsed && found) return { rate: found.rate, source: 'cbr', date: parsed.date };
    } catch {
      // нет сети или ЦБ недоступен — ниже возьмём сохранённый курс
    }
  }
  return local ? { rate: local.rate, source: 'stale', date: local.date } : null;
}

export const SETTING_RATES_REFRESHED = 'ratesRefreshedAt';
/** Курсы ЦБ меняются раз в день — проверять чаще раза в 6 часов незачем. */
export const RATES_REFRESH_MS = 6 * 60 * 60 * 1000;

/** Загрузить свежие курсы. Возвращает дату курса ЦБ и запоминает, когда обновляли. */
export async function refreshRates(fetchImpl?: FetchLike, now: number = Date.now()): Promise<string | null> {
  const date = today(new Date(now));
  requested.delete(date);
  const parsed = await loadFromCbr(date, fetchImpl);
  if (parsed) await db.settings.put({ key: SETTING_RATES_REFRESHED, value: now });
  return parsed?.date ?? null;
}

export type AutoRefreshResult = 'fresh' | 'updated' | 'offline' | 'failed';

/** Обновить курсы сами, если прошлое обновление было больше 6 часов назад. Ошибок не бросает. */
export async function autoRefreshRates({
  now = Date.now(),
  online = navigator.onLine,
  fetchImpl,
}: { now?: number; online?: boolean; fetchImpl?: FetchLike } = {}): Promise<AutoRefreshResult> {
  const last = (await db.settings.get(SETTING_RATES_REFRESHED))?.value as number | undefined;
  if (last && now - last < RATES_REFRESH_MS) return 'fresh';
  if (!online) return 'offline';
  try {
    return (await refreshRates(fetchImpl, now)) ? 'updated' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Последний сохранённый курс валюты: на сегодня или раньше, иначе любой. */
export async function latestRate(currency: string): Promise<{ rate: number; date: string } | null> {
  if (currency === RUB) return { rate: 1, date: today() };
  const found = (await localRate(currency, today())) ?? (await db.rates.where('currency').equals(currency).last());
  return found ? { rate: found.rate, date: found.date } : null;
}

export async function latestRateDate(): Promise<string | null> {
  return (await db.rates.orderBy('[date+currency]').last())?.date ?? null;
}

/**
 * Траты, записанные без сети по старому курсу, пересчитываем по курсу ЦБ на их дату.
 * Возвращает, сколько трат пересчитано.
 */
export async function recalcStaleExpenses(opts: { online?: boolean; fetchImpl?: FetchLike } = {}): Promise<number> {
  const stale = await db.expenses.filter((e) => e.rateSource === 'stale').toArray();
  let fixed = 0;
  for (const e of stale) {
    const info = await resolveRate(e.currency, e.date, opts);
    if (info?.source !== 'cbr') continue;
    await db.expenses.update(e.id, { rate: info.rate, rateSource: 'cbr', amountRub: toRub(e.amount, info.rate), updatedAt: Date.now() });
    fixed++;
  }
  return fixed;
}

/** Валюты, которыми пользовались, — от недавних к старым (для выбора валюты). */
export async function recentCurrencies(limit = 5): Promise<string[]> {
  const seen: string[] = [];
  await db.expenses
    .orderBy('date')
    .reverse()
    .until(() => seen.length >= limit)
    .each((e) => {
      if (e.currency !== RUB && !seen.includes(e.currency)) seen.push(e.currency);
    });
  return seen;
}
