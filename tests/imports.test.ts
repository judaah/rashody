import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db';
import { addExpense, recentExpenses } from '../src/db/repo';
import {
  allRules,
  alreadyImported,
  expensesNear,
  findImportProfile,
  importExpenses,
  learnRules,
  saveImportProfile,
} from '../src/db/imports';
import type { Mapping } from '../src/lib/statement';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('импорт в базу', () => {
  it('загружает строки как траты из выписки и узнаёт их при повторе', async () => {
    const count = await importExpenses([
      { date: '2026-10-26', amount: 134250, categoryId: 'groceries', note: 'Пятёрочка', externalId: 'imp:a' },
      { date: '2026-10-26', amount: 25000, categoryId: 'cafe', note: 'Кофемания', externalId: 'imp:b' },
      { date: '2026-10-24', amount: 201345, categoryId: 'fun', note: 'STEAM', externalId: 'imp:c' },
    ]);
    expect(count).toBe(3);
    const all = await db.expenses.toArray();
    expect(all.every((e) => e.source === 'import' && e.currency === 'RUB' && e.amountRub === e.amount)).toBe(true);
    expect(await alreadyImported(['imp:a', 'imp:x', 'imp:c'])).toEqual(new Set(['imp:a', 'imp:c']));
    expect(await alreadyImported([])).toEqual(new Set());
  });

  it('порядок внутри дня как в выписке (от новых к старым)', async () => {
    await importExpenses([
      { date: '2026-10-26', amount: 300, categoryId: 'cafe', note: 'третья', externalId: 'imp:3' },
      { date: '2026-10-26', amount: 200, categoryId: 'cafe', note: 'вторая', externalId: 'imp:2' },
      { date: '2026-10-25', amount: 100, categoryId: 'cafe', note: 'первая', externalId: 'imp:1' },
    ]);
    expect((await recentExpenses(10)).map((e) => e.note)).toEqual(['третья', 'вторая', 'первая']);
  });

  it('траты рядом с периодом — для поиска ручных дублей', async () => {
    await addExpense({ amount: 100, categoryId: 'cafe', date: '2026-10-09' });
    await addExpense({ amount: 100, categoryId: 'cafe', date: '2026-10-10' });
    await addExpense({ amount: 100, categoryId: 'cafe', date: '2026-10-21' });
    await addExpense({ amount: 100, categoryId: 'cafe', date: '2026-10-22' });
    expect((await expensesNear('2026-10-10', '2026-10-20')).map((e) => e.date).sort()).toEqual(['2026-10-09', '2026-10-10', '2026-10-21']);
  });
});

describe('правила и настройки колонок', () => {
  it('правило по магазину: повтор заменяет, слишком короткое не сохраняется', async () => {
    expect(await learnRules([{ description: 'PYATEROCHKA 1234 MOSCOW', categoryId: 'groceries' }])).toBe(1);
    await learnRules([
      { description: 'Pyaterochka 99', categoryId: 'other' },
      { description: '12', categoryId: 'cafe' },
    ]);
    expect(await allRules()).toEqual([{ id: 'r:pyaterochka', pattern: 'pyaterochka', categoryId: 'other' }]);
  });

  it('настройка колонок запоминается по шапке файла', async () => {
    const mapping: Mapping = { date: 0, amount: 3, description: 5, bankCategory: null, status: null, sign: 'positive' };
    expect(await findImportProfile('дата|приход|расход')).toBeNull();
    await saveImportProfile('дата|приход|расход', 'Мой банк', mapping);
    expect(await findImportProfile('дата|приход|расход')).toEqual(mapping);
  });
});
