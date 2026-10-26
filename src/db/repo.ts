import { db, type Budget, type Category, type Expense, type ExpenseSource, type RateSource, type Template } from './db';
import { RUB } from '../lib/money';
import { toRub } from '../lib/rates';
import { monthRange } from '../lib/dates';

export interface NewExpense {
  amount: number;
  categoryId: string;
  date: string;
  note?: string;
  currency?: string;
  /** Обязателен для валютной траты. */
  rate?: number;
  rateSource?: RateSource;
  source?: ExpenseSource;
  externalId?: string;
}

const newId = () => crypto.randomUUID();

export async function addExpense(input: NewExpense): Promise<Expense> {
  const now = Date.now();
  const currency = input.currency ?? RUB;
  if (currency !== RUB && !(input.rate && input.rate > 0)) throw new Error(`Нет курса для ${currency}`);
  const rate = currency === RUB ? 1 : input.rate!;
  const expense: Expense = {
    id: newId(),
    amount: input.amount,
    currency,
    amountRub: toRub(input.amount, rate),
    rate,
    categoryId: input.categoryId,
    date: input.date,
    note: input.note?.trim() ?? '',
    source: input.source ?? 'manual',
    createdAt: now,
    updatedAt: now,
  };
  if (input.externalId) expense.externalId = input.externalId;
  if (currency !== RUB) expense.rateSource = input.rateSource ?? 'manual';
  await db.expenses.add(expense);
  return expense;
}

export type ExpensePatch = Partial<Pick<Expense, 'amount' | 'categoryId' | 'date' | 'note' | 'currency' | 'rate' | 'rateSource'>>;

export async function updateExpense(id: string, patch: ExpensePatch): Promise<void> {
  const current = await db.expenses.get(id);
  if (!current) throw new Error('Трата не найдена');
  const next: Expense = { ...current, ...patch, updatedAt: Date.now() };
  if (patch.note !== undefined) next.note = patch.note.trim();
  if (next.currency === RUB) {
    next.rate = 1;
    delete next.rateSource;
  }
  next.amountRub = toRub(next.amount, next.rate);
  await db.expenses.put(next);
}

export async function deleteExpense(id: string): Promise<Expense | undefined> {
  const existing = await db.expenses.get(id);
  await db.expenses.delete(id);
  return existing;
}

/** Трата с тем же чеком или строкой выписки — чтобы не записать её дважды. */
export async function findByExternalId(externalId: string): Promise<Expense | undefined> {
  return db.expenses.where('externalId').equals(externalId).first();
}

/** Последняя записанная трата (по времени создания). */
export async function lastCreatedExpense(): Promise<Expense | undefined> {
  return db.expenses.orderBy('createdAt').last();
}

/** Вернуть удалённую трату как была (для «Вернуть» в тосте). */
export async function restoreExpense(expense: Expense): Promise<void> {
  await db.expenses.put(expense);
}

/** Траты месяца, свежие сверху. */
export async function expensesOfMonth(ym: string): Promise<Expense[]> {
  const [start, end] = monthRange(ym);
  const items = await db.expenses.where('date').between(start, end, true, false).toArray();
  return sortNewestFirst(items);
}

export async function recentExpenses(limit: number): Promise<Expense[]> {
  // Внутри одного дня индекс упорядочен по id, а не по времени создания,
  // поэтому берём все траты начиная с самой старой даты из первых `limit`.
  const top = await db.expenses.orderBy('date').reverse().limit(limit).toArray();
  if (top.length === 0) return [];
  const oldestDate = top[top.length - 1].date;
  const items = await db.expenses.where('date').aboveOrEqual(oldestDate).toArray();
  return sortNewestFirst(items).slice(0, limit);
}

export function sortNewestFirst(items: Expense[]): Expense[] {
  return items.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1));
}

/** Поиск по заметке и названию категории по всей истории. */
export async function searchExpenses(query: string, categories: Category[]): Promise<Expense[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matchedCats = new Set(categories.filter((c) => c.name.toLowerCase().includes(q)).map((c) => c.id));
  const items = await db.expenses
    .filter((e) => e.note.toLowerCase().includes(q) || matchedCats.has(e.categoryId))
    .toArray();
  return sortNewestFirst(items);
}

// ---------- категории ----------

export async function allCategories(): Promise<Category[]> {
  return db.categories.orderBy('order').toArray();
}

export async function addCategory(input: Pick<Category, 'name' | 'emoji' | 'color'>): Promise<Category> {
  const last = await db.categories.orderBy('order').last();
  const category: Category = { ...input, id: newId(), order: (last?.order ?? -1) + 1, archived: false };
  await db.categories.add(category);
  return category;
}

export async function updateCategory(id: string, patch: Partial<Omit<Category, 'id'>>): Promise<void> {
  await db.categories.update(id, patch);
}

/** Меняет местами поле order у элемента и его соседа в уже отсортированном списке. */
async function swapOrder(
  table: { update(key: string, changes: { order: number }): Promise<number> },
  sorted: Array<{ id: string; order: number }>,
  id: string,
  direction: -1 | 1,
): Promise<void> {
  const index = sorted.findIndex((x) => x.id === id);
  const neighbour = sorted[index + direction];
  if (index < 0 || !neighbour) return;
  const current = sorted[index];
  await table.update(current.id, { order: neighbour.order });
  await table.update(neighbour.id, { order: current.order });
}

/** Поменять категорию местами с соседней среди активных. */
export async function moveCategory(id: string, direction: -1 | 1): Promise<void> {
  await db.transaction('rw', db.categories, async () => {
    const active = (await db.categories.orderBy('order').toArray()).filter((c) => !c.archived);
    await swapOrder(db.categories, active, id, direction);
  });
}

// ---------- шаблоны ----------

export async function allTemplates(): Promise<Template[]> {
  return db.templates.orderBy('order').toArray();
}

export async function saveTemplate(input: Pick<Template, 'name' | 'amount' | 'categoryId'> & { id?: string }): Promise<Template> {
  const name = input.name.trim();
  if (input.id) {
    await db.templates.update(input.id, { name, amount: input.amount, categoryId: input.categoryId });
    return (await db.templates.get(input.id))!;
  }
  const last = await db.templates.orderBy('order').last();
  const template: Template = { id: newId(), name, amount: input.amount, currency: RUB, categoryId: input.categoryId, order: (last?.order ?? -1) + 1 };
  await db.templates.add(template);
  return template;
}

export async function deleteTemplate(id: string): Promise<void> {
  await db.templates.delete(id);
}

export async function moveTemplate(id: string, direction: -1 | 1): Promise<void> {
  await db.transaction('rw', db.templates, async () => {
    await swapOrder(db.templates, await db.templates.orderBy('order').toArray(), id, direction);
  });
}

/** Трата из шаблона: имя шаблона идёт в заметку, если оно не повторяет категорию. */
export async function addExpenseFromTemplate(template: Template, category: Category, date: string): Promise<Expense> {
  const sameAsCategory = template.name.trim().toLowerCase() === category.name.trim().toLowerCase();
  return addExpense({
    amount: template.amount,
    currency: template.currency,
    categoryId: template.categoryId,
    date,
    note: sameAsCategory ? '' : template.name,
    source: 'template',
  });
}

// ---------- бюджеты ----------

export async function allBudgets(): Promise<Budget[]> {
  return db.budgets.toArray();
}

/** limit = null или 0 — убрать лимит. */
export async function setBudget(categoryId: string, limit: number | null): Promise<void> {
  if (!limit || limit <= 0) await db.budgets.delete(categoryId);
  else await db.budgets.put({ categoryId, limit });
}

/** Траты за [start, end) — для отчётов за несколько месяцев. */
export async function expensesBetween(start: string, end: string): Promise<Expense[]> {
  return db.expenses.where('date').between(start, end, true, false).toArray();
}

// ---------- настройки ----------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

export const SETTING_LAST_BACKUP = 'lastBackupAt';
