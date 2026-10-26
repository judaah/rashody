// Чистые расчёты для главной, бюджетов и отчётов — без базы и без интерфейса.

import type { Budget, Category, Expense, Template } from '../db/db';
import { OTHER_CATEGORY_ID, OTHER_COLOR } from '../db/seed';
import { addDays, daysBetween, daysInMonth, monthOf, monthRange, shiftMonth } from './dates';
import { RUB } from './money';

/** Сумма трат по категориям в рублях (копейки). */
export function sumByCategory(expenses: Expense[]): Map<string, number> {
  const sums = new Map<string, number>();
  for (const e of expenses) sums.set(e.categoryId, (sums.get(e.categoryId) ?? 0) + e.amountRub);
  return sums;
}

export const sumRub = (expenses: Expense[]) => expenses.reduce((s, e) => s + e.amountRub, 0);

// ---------- пончик ----------

export interface Slice {
  /** id категории или 'rest' для свёрнутого хвоста. */
  id: string;
  color: string;
  value: number;
  share: number;
  /** Какие категории вошли в срез (у «Остальное» — несколько). */
  categoryIds: string[];
}

export const REST_ID = 'rest';

/**
 * Срезы пончика: самые крупные категории, а хвост и «Другое» сворачиваются в
 * серое «Остальное» — больше 6 цветов на одном графике уже не различить.
 */
export function donutSlices(sums: Map<string, number>, categories: Map<string, Category>, maxSlices = 5): Slice[] {
  const positive = [...sums.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = positive.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return [];
  const named = positive.filter(([id]) => id !== OTHER_CATEGORY_ID).slice(0, maxSlices);
  const namedIds = new Set(named.map(([id]) => id));
  const rest = positive.filter(([id]) => !namedIds.has(id));
  const slices: Slice[] = named.map(([id, value]) => ({
    id,
    color: categories.get(id)?.color ?? OTHER_COLOR,
    value,
    share: value / total,
    categoryIds: [id],
  }));
  const restValue = rest.reduce((s, [, v]) => s + v, 0);
  if (restValue > 0) {
    slices.push({ id: REST_ID, color: OTHER_COLOR, value: restValue, share: restValue / total, categoryIds: rest.map(([id]) => id) });
  }
  return slices;
}

export interface Segment {
  id: string;
  color: string;
  /** Длина и сдвиг в долях окружности длиной 100 (для stroke-dasharray). */
  length: number;
  offset: number;
}

/** Дуги пончика с зазором между соседями; один срез — сплошное кольцо без зазора. */
export function donutSegments(slices: Slice[], gap = 0.8): Segment[] {
  if (slices.length === 1) return [{ id: slices[0].id, color: slices[0].color, length: 100, offset: 0 }];
  let start = 0;
  return slices.map((s) => {
    const full = s.share * 100;
    const seg = { id: s.id, color: s.color, length: Math.max(full - gap, 0.4), offset: start };
    start += full;
    return seg;
  });
}

// ---------- сравнение с прошлым периодом ----------

export interface Comparison {
  /** Диапазон текущего периода [start, end). */
  current: [string, string];
  /** Диапазон периода для сравнения [start, end). */
  previous: [string, string];
  /** true — текущий месяц ещё идёт, сравниваем с тем же числом дней прошлого. */
  partial: boolean;
}

export function comparePeriods(ym: string, todayIso: string): Comparison {
  const prevYm = shiftMonth(ym, -1);
  const [prevStart, prevEnd] = monthRange(prevYm);
  if (ym !== monthOf(todayIso)) return { current: monthRange(ym), previous: [prevStart, prevEnd], partial: false };
  const day = Number(todayIso.slice(8, 10));
  const days = Math.min(day, daysInMonth(prevYm));
  return {
    current: [monthRange(ym)[0], addDays(todayIso, 1)],
    previous: [prevStart, addDays(prevStart, days)],
    partial: day < daysInMonth(ym),
  };
}

/** Изменение в процентах; null — сравнивать не с чем. */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export const inRange = (e: Expense, [start, end]: [string, string]) => e.date >= start && e.date < end;

/** Итоги по месяцам (ym → копейки). */
export function totalsByMonth(expenses: Expense[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const e of expenses) {
    const ym = monthOf(e.date);
    totals.set(ym, (totals.get(ym) ?? 0) + e.amountRub);
  }
  return totals;
}

/** Последние n месяцев, заканчивая ym включительно, от старых к новым. */
export function monthsEndingAt(ym: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => shiftMonth(ym, i - n + 1));
}

// ---------- бюджеты ----------

export type BudgetLevel = 'ok' | 'warn' | 'over';
export const BUDGET_WARN_RATIO = 0.8;

export interface BudgetState {
  limit: number;
  spent: number;
  left: number;
  ratio: number;
  level: BudgetLevel;
}

export function budgetState(spent: number, limit: number): BudgetState {
  const ratio = limit > 0 ? spent / limit : 0;
  const level: BudgetLevel = spent > limit ? 'over' : ratio >= BUDGET_WARN_RATIO ? 'warn' : 'ok';
  return { limit, spent, left: limit - spent, ratio, level };
}

/** Лимиты только по активным категориям с лимитом больше нуля. */
export function activeBudgets(budgets: Budget[], categories: Map<string, Category>): Budget[] {
  return budgets.filter((b) => b.limit > 0 && categories.get(b.categoryId) && !categories.get(b.categoryId)!.archived);
}

/** Общий бюджет месяца: сумма лимитов против трат в категориях с лимитом. */
export function budgetTotal(budgets: Budget[], sums: Map<string, number>): BudgetState | null {
  if (budgets.length === 0) return null;
  const limit = budgets.reduce((s, b) => s + b.limit, 0);
  const spent = budgets.reduce((s, b) => s + Math.max(0, sums.get(b.categoryId) ?? 0), 0);
  return budgetState(spent, limit);
}

/** Сколько можно тратить в день до конца месяца, считая сегодняшний день. */
export function dailyAllowance(left: number, todayIso: string): number {
  if (left <= 0) return 0;
  const ym = monthOf(todayIso);
  const lastDay = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
  const daysLeft = daysBetween(todayIso, lastDay) + 1;
  return Math.floor(left / daysLeft / 100) * 100; // до рубля, вниз — чтобы не обещать лишнего
}

// ---------- подсказки шаблонов ----------

export interface Suggestion {
  categoryId: string;
  amount: number;
  count: number;
}

/**
 * Частые пары «категория + сумма» в рублях, которых ещё нет среди шаблонов.
 * Берутся траты, введённые руками (импорт и чеки — не привычки).
 */
export function frequentPairs(
  expenses: Expense[],
  templates: Template[],
  categories: Map<string, Category>,
  { minCount = 3, limit = 3 } = {},
): Suggestion[] {
  const existing = new Set(templates.map((t) => `${t.categoryId}|${t.amount}`));
  const pairs = new Map<string, Suggestion & { last: string }>();
  for (const e of expenses) {
    if (e.currency !== RUB || e.amount <= 0 || e.source !== 'manual') continue;
    const cat = categories.get(e.categoryId);
    if (!cat || cat.archived) continue;
    const key = `${e.categoryId}|${e.amount}`;
    if (existing.has(key)) continue;
    const p = pairs.get(key) ?? { categoryId: e.categoryId, amount: e.amount, count: 0, last: '' };
    p.count += 1;
    if (e.date > p.last) p.last = e.date;
    pairs.set(key, p);
  }
  return [...pairs.values()]
    .filter((p) => p.count >= minCount)
    .sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1))
    .slice(0, limit)
    .map(({ categoryId, amount, count }) => ({ categoryId, amount, count }));
}
