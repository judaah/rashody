import { db, type Expense, type Rule } from './db';
import { addDays } from '../lib/dates';
import { merchantKey } from '../lib/autocat';
import type { Mapping } from '../lib/statement';

export async function allRules(): Promise<Rule[]> {
  return db.rules.toArray();
}

/** Запомнить «этот магазин → эта категория». Ключ правила — сам магазин, новое правило заменяет старое. */
export async function learnRules(items: Array<{ description: string; categoryId: string }>): Promise<number> {
  const rules = new Map<string, Rule>();
  for (const { description, categoryId } of items) {
    const pattern = merchantKey(description);
    if (pattern.length < 3) continue;
    rules.set(pattern, { id: `r:${pattern}`, pattern, categoryId });
  }
  await db.rules.bulkPut([...rules.values()]);
  return rules.size;
}

/** Настройка колонок, сохранённая для выписки с такой же шапкой. */
export async function findImportProfile(signature: string): Promise<Mapping | null> {
  const profile = await db.importProfiles.where('signature').equals(signature).first();
  return profile ? (profile.mapping as unknown as Mapping) : null;
}

export async function saveImportProfile(signature: string, name: string, mapping: Mapping): Promise<void> {
  await db.importProfiles.put({ id: `p:${signature}`, name, signature, mapping: { ...mapping } });
}

/** Какие строки этой выписки уже загружались раньше. */
export async function alreadyImported(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const found = await db.expenses.where('externalId').anyOf(ids).toArray();
  return new Set(found.map((e) => e.externalId!));
}

/** Траты рядом с периодом выписки (±1 день) — кандидаты на совпадение с ручными записями. */
export async function expensesNear(from: string, to: string): Promise<Expense[]> {
  return db.expenses.where('date').between(addDays(from, -1), addDays(to, 2), true, false).toArray();
}

export interface ImportItem {
  date: string;
  amount: number;
  categoryId: string;
  note: string;
  externalId: string;
}

/** Все строки — одной транзакцией: либо загрузились все, либо ни одной. */
export async function importExpenses(items: ImportItem[]): Promise<number> {
  const now = Date.now();
  // Внутри дня траты показываются по времени создания. Банки пишут выписку то сверху вниз
  // от новых к старым, то наоборот — подстраиваемся, чтобы порядок совпал с выпиской.
  const newestFirst = items.length > 1 && items[0].date > items[items.length - 1].date;
  const rows: Expense[] = items.map((it, i) => ({
    id: crypto.randomUUID(),
    amount: it.amount,
    currency: 'RUB',
    amountRub: it.amount,
    rate: 1,
    categoryId: it.categoryId,
    date: it.date,
    note: it.note,
    source: 'import',
    externalId: it.externalId,
    createdAt: now + (newestFirst ? items.length - i : i),
    updatedAt: now,
  }));
  await db.transaction('rw', db.expenses, () => db.expenses.bulkAdd(rows));
  return rows.length;
}
