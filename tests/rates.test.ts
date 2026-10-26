import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import { addExpense } from '../src/db/repo';
import { autoRefreshRates, latestRate, latestRateDate, localRate, recalcStaleExpenses, recentCurrencies, resolveRate, saveRates } from '../src/db/rates';
import {
  CBR_LATEST_URL,
  cbrArchiveUrl,
  currencyName,
  type FetchLike,
  currencySymbol,
  displayNominal,
  fetchCbrRates,
  formatRate,
  parseCbr,
  toRub,
} from '../src/lib/rates';
import fixture from './fixtures/cbr-2026-10-24.json';

// Настоящий ответ ЦБ на 24.10.2026 (урезан до 5 валют).
const plain = (s: string) => s.replace(/[  ]/g, ' ');

/**
 * Подменный cbr-xml-daily.ru, как он ведёт себя в браузере: последние курсы отдаются всегда,
 * архив — только на перечисленные даты, а 404 приходит без CORS-заголовка, то есть браузер
 * бросает TypeError, а не отдаёт ответ со статусом.
 */
function fakeCbr(byDate: Record<string, unknown>, latest: unknown = fixture) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(url);
    if (url === CBR_LATEST_URL) return new Response(JSON.stringify(latest), { status: 200 });
    const m = url.match(/archive\/(\d{4})\/(\d{2})\/(\d{2})\//);
    const body = m && byDate[`${m[1]}-${m[2]}-${m[3]}`];
    if (!body) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { impl: impl as FetchLike, calls };
}

const day = (u: string) => u.match(/\d{4}\/\d{2}\/\d{2}/)?.[0] ?? 'latest';

const withDate = (date: string, usd: number, previousDate = '2000-01-01') => ({
  ...fixture,
  Date: `${date}T11:30:00+03:00`,
  PreviousDate: `${previousDate}T11:30:00+03:00`,
  Valute: { ...fixture.Valute, USD: { ...fixture.Valute.USD, Value: usd } },
});

describe('разбор ответа ЦБ', () => {
  it('курс за 1 единицу с учётом номинала', () => {
    const parsed = parseCbr(fixture);
    expect(parsed.date).toBe('2026-10-24');
    const rate = Object.fromEntries(parsed.rates.map((r) => [r.currency, r.rate]));
    expect(rate.USD).toBeCloseTo(80.5381);
    expect(rate.KZT).toBeCloseTo(0.179797);
    expect(rate.VND).toBeCloseTo(0.0031427);
  });

  it('чужой формат — понятная ошибка', () => {
    expect(() => parseCbr({ foo: 1 })).toThrow('Неожиданный ответ ЦБ');
  });

  it('адрес архива', () => {
    expect(cbrArchiveUrl('2026-01-05')).toBe('https://www.cbr-xml-daily.ru/archive/2026/01/05/daily_json.js');
  });

  it('предыдущие курсы берутся из того же ответа', () => {
    const prev = parseCbr(fixture, 'previous');
    expect(prev.date).toBe('2026-10-23');
    expect(prev.rates.find((r) => r.currency === 'USD')!.rate).toBeCloseTo(81.1255);
  });

  it('сегодня и выходные — из последних курсов, без архива', async () => {
    const { impl, calls } = fakeCbr({});
    expect((await fetchCbrRates('2026-10-26', impl))?.date).toBe('2026-10-24'); // понедельник → курс субботы
    expect((await fetchCbrRates('2026-10-23', impl))?.date).toBe('2026-10-23'); // пятница → «Previous»
    expect(calls.map(day)).toEqual(['latest', 'latest']);
  });

  it('ЦБ уже выложил курс на завтра — сегодня берётся предыдущий', async () => {
    const { impl } = fakeCbr({}, withDate('2026-10-27', 82, '2026-10-24'));
    const parsed = await fetchCbrRates('2026-10-26', impl);
    expect(parsed?.date).toBe('2026-10-24');
  });

  it('старые даты — архив; в выходной 404 без CORS не считается обрывом сети', async () => {
    const { impl, calls } = fakeCbr({ '2026-10-16': withDate('2026-10-16', 78) });
    const parsed = await fetchCbrRates('2026-10-18', impl); // воскресенье
    expect(parsed?.date).toBe('2026-10-16');
    expect(calls.map(day)).toEqual(['latest', '2026/10/18', '2026/10/17', '2026/10/16']);
  });

  it('нет сети — ошибка сразу, без перебора архива', async () => {
    const calls: string[] = [];
    const offline: FetchLike = async (url) => {
      calls.push(url);
      throw new TypeError('Failed to fetch');
    };
    await expect(fetchCbrRates('2026-10-18', offline)).rejects.toThrow('Failed to fetch');
    expect(calls).toEqual([CBR_LATEST_URL]);
  });

  it('сбой ЦБ — ошибка, а не тихий пропуск дня', async () => {
    const impl: FetchLike = async () => new Response('', { status: 503 });
    await expect(fetchCbrRates('2026-10-26', impl)).rejects.toThrow('503');
  });
});

describe('показ курсов', () => {
  it('номинал как у ЦБ для мелких валют', () => {
    expect(displayNominal(80.5)).toBe(1);
    expect(displayNominal(0.1798)).toBe(100);
    expect(displayNominal(0.0031427)).toBe(10000);
    expect(plain(formatRate(80.5381, 'USD'))).toBe('1 USD = 80,54 ₽');
    expect(plain(formatRate(0.179797, 'KZT'))).toBe('100 KZT = 17,98 ₽');
    expect(plain(formatRate(0.0031427, 'VND'))).toBe('10 000 VND = 31,43 ₽');
  });

  it('пересчёт в рубли в копейках', () => {
    expect(toRub(2500, 80.5381)).toBe(201345); // 25 $ → 2 013,45 ₽
    expect(toRub(500000, 0.179797)).toBe(89899); // 5 000 ₸ → 898,99 ₽
  });

  it('названия и знаки валют', () => {
    expect(currencyName('USD')).toBe('Доллар США');
    expect(currencyName('RUB')).toBe('Российский рубль');
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('EUR')).toBe('€');
  });
});

describe('курс для траты', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('берёт ЦБ из сети и сохраняет курсы', async () => {
    const { impl } = fakeCbr({ '2026-10-24': fixture });
    const info = await resolveRate('USD', '2026-10-26', { online: true, fetchImpl: impl });
    expect(info).toMatchObject({ source: 'cbr', date: '2026-10-24' });
    expect(info!.rate).toBeCloseTo(80.5381);
    expect((await localRate('KZT', '2026-10-26'))?.rate).toBeCloseTo(0.179797);
    expect(await latestRateDate()).toBe('2026-10-24');
  });

  it('сохранённый курс на эту же дату — без сети', async () => {
    await saveRates(parseCbr(withDate('2026-10-23', 81.1255)));
    const { impl, calls } = fakeCbr({});
    const info = await resolveRate('USD', '2026-10-23', { online: true, fetchImpl: impl });
    expect(info).toMatchObject({ source: 'cbr', date: '2026-10-23', rate: 81.1255 });
    expect(calls).toEqual([]);
  });

  it('без сети — последний сохранённый курс с пометкой stale; совсем без курса — null', async () => {
    expect(await resolveRate('USD', '2026-10-26', { online: false })).toBeNull();
    await saveRates(parseCbr(withDate('2026-10-20', 79)));
    expect(await resolveRate('USD', '2026-10-26', { online: false })).toMatchObject({ source: 'stale', date: '2026-10-20', rate: 79 });
    // курс из будущего относительно траты не используется
    expect(await resolveRate('USD', '2026-10-19', { online: false })).toBeNull();
  });

  it('сеть упала — тоже stale, а не ошибка', async () => {
    await saveRates(parseCbr(withDate('2026-10-20', 79)));
    const broken: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await resolveRate('USD', '2026-10-22', { online: true, fetchImpl: broken })).toMatchObject({ source: 'stale' });
  });

  it('рубль — всегда 1', async () => {
    expect(await resolveRate('RUB', '2026-10-26', { online: false })).toMatchObject({ rate: 1, source: 'cbr' });
  });

  it('траты по старому курсу пересчитываются, когда появилась сеть', async () => {
    await saveRates(parseCbr(withDate('2026-10-20', 79)));
    const stale = await addExpense({ amount: 2500, currency: 'USD', rate: 79, rateSource: 'stale', categoryId: 'cafe', date: '2026-10-21' });
    const manual = await addExpense({ amount: 1000, currency: 'USD', rate: 100, rateSource: 'manual', categoryId: 'cafe', date: '2026-10-21' });
    expect(stale.amountRub).toBe(197500);

    expect(await recalcStaleExpenses({ online: false })).toBe(0);
    const { impl } = fakeCbr({ '2026-10-21': withDate('2026-10-21', 80) });
    expect(await recalcStaleExpenses({ online: true, fetchImpl: impl })).toBe(1);
    expect(await db.expenses.get(stale.id)).toMatchObject({ rate: 80, rateSource: 'cbr', amountRub: 200000 });
    expect(await db.expenses.get(manual.id)).toMatchObject({ rate: 100, rateSource: 'manual' }); // ручной курс не трогаем
  });

  it('валютная трата без курса не сохраняется', async () => {
    await expect(addExpense({ amount: 100, currency: 'USD', categoryId: 'cafe', date: '2026-10-26' })).rejects.toThrow('Нет курса');
  });

  it('курсы обновляются сами не чаще раза в 6 часов, без сети — молча пропускают', async () => {
    const t0 = Date.parse('2026-10-26T10:00:00');
    const { impl, calls } = fakeCbr({});
    expect(await autoRefreshRates({ now: t0, online: false, fetchImpl: impl })).toBe('offline');
    expect(await autoRefreshRates({ now: t0, online: true, fetchImpl: impl })).toBe('updated');
    expect(calls).toHaveLength(1);
    expect(await autoRefreshRates({ now: t0 + 5 * 3600_000, online: true, fetchImpl: impl })).toBe('fresh');
    expect(calls).toHaveLength(1);
    expect(await autoRefreshRates({ now: t0 + 7 * 3600_000, online: true, fetchImpl: impl })).toBe('updated');
    const broken: FetchLike = async () => new Response('', { status: 503 });
    expect(await autoRefreshRates({ now: t0 + 14 * 3600_000, online: true, fetchImpl: broken })).toBe('failed');
  });

  it('последний курс для валюты просмотра', async () => {
    expect(await latestRate('USD')).toBeNull();
    expect(await latestRate('RUB')).toMatchObject({ rate: 1 });
    await saveRates(parseCbr(withDate('2026-10-20', 79)));
    await saveRates(parseCbr(withDate('2026-10-24', 80.5381)));
    expect(await latestRate('USD')).toEqual({ rate: 80.5381, date: '2026-10-24' });
  });

  it('недавние валюты — от свежих к старым, без рубля и повторов', async () => {
    await addExpense({ amount: 100, currency: 'KZT', rate: 0.18, categoryId: 'cafe', date: '2026-10-01' });
    await addExpense({ amount: 100, currency: 'USD', rate: 80, categoryId: 'cafe', date: '2026-10-10' });
    await addExpense({ amount: 100, categoryId: 'cafe', date: '2026-10-11' });
    await addExpense({ amount: 100, currency: 'USD', rate: 80, categoryId: 'cafe', date: '2026-10-05' });
    expect(await recentCurrencies()).toEqual(['USD', 'KZT']);
  });
});
