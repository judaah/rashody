// Снимок моих трат для партнёра: что уходит к нему (в зашифрованном виде) и как это
// проверяется на входе. Партнёр видит все траты целиком — так решили в спеке.

import type { Category, Expense } from '../db/db';

export interface Snapshot {
  v: 1;
  /** Имя владельца — так партнёр видит, чьи это траты. */
  name: string;
  categories: Category[];
  /** Без externalId: ключи чеков и строк выписки партнёру не нужны. */
  expenses: Expense[];
}

export function buildSnapshot(name: string, categories: Category[], expenses: Expense[]): Snapshot {
  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    v: 1,
    name: name.trim(),
    // одинаковый порядок → одинаковый отпечаток, если ничего не менялось
    categories: [...categories].sort(byId),
    expenses: expenses
      .map((e) => {
        const { externalId: _drop, ...rest } = e;
        return rest as Expense;
      })
      .sort(byId),
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Снимок пришёл от партнёра: проверяем форму и выбрасываем битые записи, а не падаем. */
export function readSnapshot(input: unknown): Snapshot {
  const s = input as Partial<Snapshot> | null;
  if (!s || s.v !== 1 || !Array.isArray(s.categories) || !Array.isArray(s.expenses)) {
    throw new Error('Снимок партнёра в неизвестном формате — обновите приложение у обоих');
  }
  const categories = s.categories.filter(
    (c): c is Category => !!c && isStr(c.id) && isStr(c.name) && isStr(c.emoji) && isStr(c.color) && isNum(c.order),
  );
  const expenses = s.expenses.filter(
    (e): e is Expense =>
      !!e && isStr(e.id) && isNum(e.amount) && isNum(e.amountRub) && isStr(e.currency) && isStr(e.categoryId) && isStr(e.date) && /^\d{4}-\d{2}-\d{2}$/.test(e.date),
  );
  return {
    v: 1,
    name: isStr(s.name) ? s.name.slice(0, 40) : '',
    categories: categories.map((c) => ({ ...c, archived: !!c.archived })),
    expenses: expenses.map((e) => ({
      ...e,
      note: isStr(e.note) ? e.note : '',
      rate: isNum(e.rate) ? e.rate : 1,
      source: e.source ?? 'manual',
      createdAt: isNum(e.createdAt) ? e.createdAt : 0,
      updatedAt: isNum(e.updatedAt) ? e.updatedAt : 0,
    })),
  };
}
