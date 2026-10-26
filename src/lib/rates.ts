// Курсы ЦБ РФ с cbr-xml-daily.ru. В запросе только дата — никаких данных о тратах.
// Курс храним «рублей за 1 единицу валюты»; ЦБ даёт его за номинал (100 KZT = 17,98 ₽).

import { addDays } from './dates';
import { RUB } from './money';

/** Валюты, которые публикует ЦБ (без СДР). */
export const CBR_CURRENCIES = [
  'USD', 'EUR', 'CNY', 'KZT', 'TRY', 'AED', 'GEL', 'AMD', 'BYN', 'UZS', 'KGS', 'TJS', 'AZN', 'THB', 'VND', 'INR',
  'GBP', 'JPY', 'KRW', 'CHF', 'HKD', 'SGD', 'IDR', 'EGP', 'SAR', 'QAR', 'BHD', 'OMR', 'CAD', 'AUD', 'NZD', 'CZK',
  'PLN', 'HUF', 'RON', 'RSD', 'SEK', 'NOK', 'DKK', 'MDL', 'MNT', 'TMT', 'UAH', 'BRL', 'ZAR', 'BDT', 'BOB', 'CUP',
  'DZD', 'ETB', 'IRR', 'MMK', 'NGN',
];

export interface ParsedRates {
  /** Дата, на которую ЦБ установил курс ('YYYY-MM-DD'). */
  date: string;
  rates: Array<{ currency: string; rate: number }>;
}

type CbrJson = {
  Date?: unknown;
  PreviousDate?: unknown;
  Valute?: Record<string, { CharCode?: unknown; Nominal?: unknown; Value?: unknown; Previous?: unknown }>;
};

/**
 * Разбирает ответ daily_json.js. which = 'previous' — курсы на PreviousDate
 * (они лежат в том же ответе в поле Previous). Бросает ошибку, если формат не тот.
 */
export function parseCbr(json: unknown, which: 'current' | 'previous' = 'current'): ParsedRates {
  const data = json as CbrJson;
  const dateField = which === 'current' ? data?.Date : data?.PreviousDate;
  if (typeof dateField !== 'string' || typeof data.Valute !== 'object' || !data.Valute) {
    throw new Error('Неожиданный ответ ЦБ');
  }
  const rates: ParsedRates['rates'] = [];
  for (const v of Object.values(data.Valute)) {
    const value = which === 'current' ? v.Value : v.Previous;
    if (typeof v.CharCode !== 'string' || typeof v.Nominal !== 'number' || typeof value !== 'number') continue;
    if (v.Nominal <= 0 || value <= 0) continue;
    rates.push({ currency: v.CharCode, rate: value / v.Nominal });
  }
  return { date: dateField.slice(0, 10), rates };
}

export type FetchLike = (url: string) => Promise<Response>;

export const CBR_LATEST_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';

export function cbrArchiveUrl(date: string): string {
  const [y, m, d] = date.split('-');
  return `https://www.cbr-xml-daily.ru/archive/${y}/${m}/${d}/daily_json.js`;
}

const FETCH_TIMEOUT_MS = 8000;

/** fetch с таймаутом: на плохой сети окно ввода не должно висеть на «Загружаю курс». */
function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * Курсы, действующие на дату.
 *
 * Сначала берём последние курсы: в том же ответе есть и предыдущие, этого хватает
 * для сегодня и пары дней назад. Если этот запрос упал — сети нет, ошибка уходит наверх.
 * Для дат старше идём в архив. На выходные и праздники ЦБ курс не ставит, и архив
 * отвечает 404 без CORS-заголовка — браузер отдаёт это как сетевую ошибку. Сеть мы уже
 * проверили первым запросом, поэтому такую ошибку считаем «курса на этот день нет» и идём
 * на день назад (в новогодние праздники пропуск бывает больше недели).
 */
export async function fetchCbrRates(
  date: string,
  fetchImpl: FetchLike = fetchWithTimeout,
  maxDaysBack = 14,
): Promise<ParsedRates | null> {
  const latestResponse = await fetchImpl(CBR_LATEST_URL);
  if (!latestResponse.ok) throw new Error(`ЦБ ответил ${latestResponse.status}`);
  const latestJson: unknown = await latestResponse.json();
  const latest = parseCbr(latestJson);
  if (date >= latest.date) return latest;
  const previous = parseCbr(latestJson, 'previous');
  if (date >= previous.date) return previous;

  for (let back = 0; back <= maxDaysBack; back++) {
    let response: Response;
    try {
      response = await fetchImpl(cbrArchiveUrl(addDays(date, -back)));
    } catch {
      continue;
    }
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`ЦБ ответил ${response.status}`);
    return parseCbr(await response.json());
  }
  return null;
}

export const toRub = (amount: number, rate: number) => Math.round(amount * rate);

/** Номинал для показа: курс мелких валют удобнее читать за 100 или 10 000 единиц, как у ЦБ. */
export function displayNominal(rate: number): number {
  let nominal = 1;
  while (rate * nominal < 10 && rate < 1 && nominal < 1_000_000) nominal *= 10;
  return nominal;
}

const rateFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/** «1 USD = 80,54 ₽», «100 KZT = 17,98 ₽» */
export function formatRate(rate: number, currency: string): string {
  const nominal = displayNominal(rate);
  return `${nominal.toLocaleString('ru-RU')} ${currency} = ${rateFmt.format(rate * nominal)} ₽`;
}

let namesFmt: Intl.DisplayNames | null = null;

/** «Доллар США», «Казахстанский тенге». */
export function currencyName(code: string): string {
  if (code === RUB) return 'Российский рубль';
  try {
    namesFmt ??= new Intl.DisplayNames(['ru'], { type: 'currency' });
    const name = namesFmt.of(code) ?? code;
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return code;
  }
}

/** «$», «€», «₸»; если у валюты нет своего знака — её код. */
export function currencySymbol(code: string): string {
  const parts = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).formatToParts(1);
  return parts.find((p) => p.type === 'currency')?.value ?? code;
}
