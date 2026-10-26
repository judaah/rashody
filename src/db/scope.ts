// Траты для режима «Я / Партнёр / Вместе». Мои и партнёра лежат в разных таблицах;
// здесь они читаются нужными и помечаются владельцем.

import type { Table } from 'dexie';
import { db, type Category, type Expense } from './db';
import { sortNewestFirst } from './repo';
import { monthRange } from '../lib/dates';

export type Scope = 'me' | 'partner' | 'together';
export type Owner = 'me' | 'partner';
export type OwnedExpense = Expense & { owner: Owner };

type ExpenseTable = Table<Expense, string>;

async function read(scope: Scope, query: (t: ExpenseTable) => Promise<Expense[]>): Promise<OwnedExpense[]> {
  const parts: OwnedExpense[][] = [];
  if (scope !== 'partner') parts.push((await query(db.expenses as ExpenseTable)).map((e) => ({ ...e, owner: 'me' as const })));
  if (scope !== 'me') parts.push((await query(db.partnerExpenses as ExpenseTable)).map((e) => ({ ...e, owner: 'partner' as const })));
  return sortNewestFirst(parts.flat());
}

export function scopedBetween(start: string, end: string, scope: Scope): Promise<OwnedExpense[]> {
  return read(scope, (t) => t.where('date').between(start, end, true, false).toArray());
}

export function scopedMonth(ym: string, scope: Scope): Promise<OwnedExpense[]> {
  const [start, end] = monthRange(ym);
  return scopedBetween(start, end, scope);
}

/** Последние траты: в каждой таблице берём все траты начиная с даты limit-й, потом сливаем. */
export async function scopedRecent(limit: number, scope: Scope): Promise<OwnedExpense[]> {
  const all = await read(scope, async (t) => {
    const top = await t.orderBy('date').reverse().limit(limit).toArray();
    if (top.length === 0) return [];
    return t.where('date').aboveOrEqual(top[top.length - 1].date).toArray();
  });
  return all.slice(0, limit);
}

export async function scopedSearch(query: string, scope: Scope, categories: Map<string, Category>): Promise<OwnedExpense[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matchedCats = new Set([...categories.values()].filter((c) => c.name.toLowerCase().includes(q)).map((c) => c.id));
  return read(scope, (t) => t.filter((e) => e.note.toLowerCase().includes(q) || matchedCats.has(e.categoryId)).toArray());
}

/** Самая ранняя дата трат в режиме — для «в среднем в день». */
export async function scopedFirstDate(scope: Scope): Promise<string | null> {
  const dates: string[] = [];
  if (scope !== 'partner') {
    const first = await db.expenses.orderBy('date').first();
    if (first) dates.push(first.date);
  }
  if (scope !== 'me') {
    const first = await db.partnerExpenses.orderBy('date').first();
    if (first) dates.push(first.date);
  }
  return dates.sort()[0] ?? null;
}

/**
 * Категории для показа: мои плюс те категории партнёра, которых у меня нет (его свои).
 * Стартовые категории у всех с одинаковыми id — в режиме «Вместе» они складываются.
 */
export function mergeCategories(mine: Category[], partners: Category[]): Category[] {
  const ids = new Set(mine.map((c) => c.id));
  const maxOrder = Math.max(-1, ...mine.map((c) => c.order));
  return [...mine, ...partners.filter((c) => !ids.has(c.id)).map((c, i) => ({ ...c, order: maxOrder + 1 + i }))];
}
