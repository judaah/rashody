import { describe, expect, it } from 'vitest';
import type { Category, Expense, Template } from '../src/db/db';
import { DEFAULT_CATEGORIES, OTHER_COLOR } from '../src/db/seed';
import {
  budgetState,
  budgetTotal,
  activeBudgets,
  comparePeriods,
  dailyAllowance,
  donutSegments,
  donutSlices,
  frequentPairs,
  monthsEndingAt,
  percentChange,
  REST_ID,
  sumByCategory,
  totalsByMonth,
} from '../src/lib/stats';

const cats = new Map<string, Category>(DEFAULT_CATEGORIES.map((c) => [c.id, c]));

let seq = 0;
const exp = (categoryId: string, amountRub: number, date = '2026-10-10', extra: Partial<Expense> = {}): Expense => ({
  id: String(++seq),
  amount: amountRub,
  currency: 'RUB',
  amountRub,
  rate: 1,
  categoryId,
  date,
  note: '',
  source: 'manual',
  createdAt: seq,
  updatedAt: seq,
  ...extra,
});

describe('пончик', () => {
  it('крупные категории отдельно, хвост и «Другое» — в сером «Остальное»', () => {
    const sums = sumByCategory([
      exp('groceries', 600),
      exp('cafe', 500),
      exp('transport', 400),
      exp('taxi', 300),
      exp('home', 200),
      exp('health', 100),
      exp('other', 900), // крупное, но «Другое» всё равно уходит в хвост
      exp('fun', -50), // возврат не рисуется
    ]);
    const slices = donutSlices(sums, cats);
    expect(slices.map((s) => s.id)).toEqual(['groceries', 'cafe', 'transport', 'taxi', 'home', REST_ID]);
    const rest = slices.at(-1)!;
    expect(rest.color).toBe(OTHER_COLOR);
    expect(rest.categoryIds.sort()).toEqual(['health', 'other']);
    expect(rest.value).toBe(1000);
    expect(slices.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1);
  });

  it('без трат — пусто, одна категория — сплошное кольцо', () => {
    expect(donutSlices(new Map(), cats)).toEqual([]);
    const one = donutSlices(new Map([['cafe', 100]]), cats);
    expect(donutSegments(one)).toEqual([{ id: 'cafe', color: cats.get('cafe')!.color, length: 100, offset: 0 }]);
  });

  it('дуги идут подряд с зазором и не вылезают за круг', () => {
    const slices = donutSlices(new Map([['cafe', 750], ['taxi', 250]]), cats);
    const [a, b] = donutSegments(slices, 1);
    expect(a.offset).toBe(0);
    expect(a.length).toBeCloseTo(74);
    expect(b.offset).toBeCloseTo(75);
    expect(b.offset + b.length).toBeLessThanOrEqual(100);
  });
});

describe('сравнение периодов', () => {
  it('идущий месяц сравнивается с тем же числом дней прошлого', () => {
    expect(comparePeriods('2026-10', '2026-10-26')).toEqual({
      current: ['2026-10-01', '2026-10-27'],
      previous: ['2026-09-01', '2026-09-27'],
      partial: true,
    });
  });

  it('31-е число против 30-дневного месяца — весь прошлый месяц', () => {
    expect(comparePeriods('2026-10', '2026-10-31').previous).toEqual(['2026-09-01', '2026-10-01']);
    expect(comparePeriods('2026-03', '2026-03-30').previous).toEqual(['2026-02-01', '2026-03-01']);
  });

  it('прошедший месяц сравнивается целиком', () => {
    expect(comparePeriods('2026-09', '2026-10-26')).toEqual({
      current: ['2026-09-01', '2026-10-01'],
      previous: ['2026-08-01', '2026-09-01'],
      partial: false,
    });
  });

  it('процент изменения', () => {
    expect(percentChange(110, 100)).toBe(10);
    expect(percentChange(88, 100)).toBe(-12);
    expect(percentChange(100, 0)).toBeNull();
  });

  it('итоги по месяцам и окно месяцев', () => {
    const totals = totalsByMonth([exp('cafe', 100, '2026-09-30'), exp('cafe', 50, '2026-10-01'), exp('taxi', 25, '2026-10-31')]);
    expect(Object.fromEntries(totals)).toEqual({ '2026-09': 100, '2026-10': 75 });
    expect(monthsEndingAt('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('бюджеты', () => {
  it('уровни: норма, 80% — предупреждение, сверх лимита — перерасход', () => {
    expect(budgetState(7900, 10000).level).toBe('ok');
    expect(budgetState(8000, 10000).level).toBe('warn');
    expect(budgetState(10000, 10000).level).toBe('warn');
    expect(budgetState(10001, 10000)).toMatchObject({ level: 'over', left: -1 });
  });

  it('общий бюджет считает только категории с лимитом, архивные не учитываются', () => {
    const withArchived = new Map(cats);
    withArchived.set('taxi', { ...cats.get('taxi')!, archived: true });
    const budgets = activeBudgets(
      [
        { categoryId: 'cafe', limit: 10000 },
        { categoryId: 'groceries', limit: 20000 },
        { categoryId: 'taxi', limit: 5000 },
        { categoryId: 'fun', limit: 0 },
      ],
      withArchived,
    );
    expect(budgets.map((b) => b.categoryId)).toEqual(['cafe', 'groceries']);
    const sums = new Map([
      ['cafe', 12000],
      ['groceries', 5000],
      ['transport', 99999],
    ]);
    expect(budgetTotal(budgets, sums)).toMatchObject({ limit: 30000, spent: 17000, left: 13000, level: 'ok' });
    expect(budgetTotal([], sums)).toBeNull();
  });

  it('сколько можно тратить в день до конца месяца', () => {
    expect(dailyAllowance(600000, '2026-10-26')).toBe(100000); // 26–31 октября = 6 дней
    expect(dailyAllowance(100, '2026-10-31')).toBe(100);
    expect(dailyAllowance(100050, '2026-10-30')).toBe(50000); // 500,25 ₽ → 500 ₽
    expect(dailyAllowance(-5, '2026-10-01')).toBe(0);
  });
});

describe('подсказки шаблонов', () => {
  it('частые пары, без уже существующих шаблонов, импорта и возвратов', () => {
    const expenses = [
      ...Array.from({ length: 5 }, (_, i) => exp('cafe', 25000, `2026-10-0${i + 1}`)),
      ...Array.from({ length: 3 }, () => exp('transport', 7000)),
      ...Array.from({ length: 4 }, () => exp('groceries', 100000, '2026-10-10', { source: 'import' })),
      ...Array.from({ length: 2 }, () => exp('taxi', 50000)),
      ...Array.from({ length: 3 }, () => exp('taxi', -50000)),
    ];
    const templates: Template[] = [];
    expect(frequentPairs(expenses, templates, cats)).toEqual([
      { categoryId: 'cafe', amount: 25000, count: 5 },
      { categoryId: 'transport', amount: 7000, count: 3 },
    ]);
    templates.push({ id: 't', name: 'Кофе', amount: 25000, currency: 'RUB', categoryId: 'cafe', order: 0 });
    expect(frequentPairs(expenses, templates, cats).map((s) => s.categoryId)).toEqual(['transport']);
  });
});
