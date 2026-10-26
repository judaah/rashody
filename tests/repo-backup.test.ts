import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db';
import { DEFAULT_CATEGORIES } from '../src/db/seed';
import {
  addCategory,
  addExpense,
  addExpenseFromTemplate,
  allBudgets,
  allCategories,
  allTemplates,
  deleteTemplate,
  moveTemplate,
  saveTemplate,
  setBudget,
  deleteExpense,
  expensesOfMonth,
  getSetting,
  moveCategory,
  recentExpenses,
  restoreExpense,
  searchExpenses,
  setSetting,
  SETTING_LAST_BACKUP,
  updateExpense,
} from '../src/db/repo';
import {
  exportBackup,
  expensesToCsv,
  needsBackupReminder,
  parseBackup,
  restoreBackup,
  validateBackup,
} from '../src/lib/backup';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('база', () => {
  it('при первом запуске создаёт стартовые категории', async () => {
    const cats = await allCategories();
    expect(cats.map((c) => c.name)).toEqual(DEFAULT_CATEGORIES.map((c) => c.name));
  });

  it('добавляет, меняет и удаляет трату; удалённую можно вернуть', async () => {
    const e = await addExpense({ amount: 25000, categoryId: 'cafe', date: '2026-10-26', note: '  кофе  ' });
    expect(e).toMatchObject({ amount: 25000, amountRub: 25000, currency: 'RUB', rate: 1, note: 'кофе', source: 'manual' });

    await updateExpense(e.id, { amount: 30000, note: 'кофе и круассан' });
    const updated = await db.expenses.get(e.id);
    expect(updated).toMatchObject({ amount: 30000, amountRub: 30000, note: 'кофе и круассан' });
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(e.updatedAt);

    const removed = await deleteExpense(e.id);
    expect(await db.expenses.count()).toBe(0);
    await restoreExpense(removed!);
    expect(await db.expenses.get(e.id)).toEqual(updated);
  });

  it('траты месяца не захватывают соседние месяцы и идут от новых к старым', async () => {
    await addExpense({ amount: 100, categoryId: 'cafe', date: '2026-09-30' });
    const a = await addExpense({ amount: 200, categoryId: 'cafe', date: '2026-10-01' });
    const b = await addExpense({ amount: 300, categoryId: 'cafe', date: '2026-10-31' });
    const c = await addExpense({ amount: 400, categoryId: 'cafe', date: '2026-10-31' });
    await addExpense({ amount: 500, categoryId: 'cafe', date: '2026-11-01' });
    await db.expenses.update(b.id, { createdAt: 1000 });
    await db.expenses.update(c.id, { createdAt: 2000 });
    const month = await expensesOfMonth('2026-10');
    expect(month.map((e) => e.id)).toEqual([c.id, b.id, a.id]);
  });

  it('последние траты внутри дня сортируются по времени создания', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await addExpense({ amount: 100 + i, categoryId: 'cafe', date: '2026-10-26' })).id);
    await addExpense({ amount: 1, categoryId: 'cafe', date: '2026-10-20' });
    // createdAt может совпасть в пределах миллисекунды — разводим явно
    await Promise.all(ids.map((id, i) => db.expenses.update(id, { createdAt: 1000 + i })));
    const recent = await recentExpenses(3);
    expect(recent.map((e) => e.id)).toEqual([ids[5], ids[4], ids[3]]);
  });

  it('поиск по заметке и по названию категории', async () => {
    await addExpense({ amount: 100, categoryId: 'cafe', date: '2026-10-01', note: 'Кофе с Машей' });
    await addExpense({ amount: 200, categoryId: 'taxi', date: '2026-10-02' });
    await addExpense({ amount: 300, categoryId: 'groceries', date: '2026-10-03', note: 'вкусвилл' });
    const cats = await allCategories();
    expect((await searchExpenses('маш', cats)).map((e) => e.amount)).toEqual([100]);
    expect((await searchExpenses('такси', cats)).map((e) => e.amount)).toEqual([200]);
    expect(await searchExpenses('   ', cats)).toEqual([]);
  });

  it('категории: новая встаёт в конец, перестановка меняет порядок', async () => {
    const created = await addCategory({ name: 'Спорт', emoji: '🏀', color: '#3b82f6' });
    let cats = await allCategories();
    expect(cats.at(-1)!.id).toBe(created.id);
    await moveCategory(created.id, -1);
    cats = await allCategories();
    expect(cats.at(-2)!.id).toBe(created.id);
    await moveCategory(cats[0].id, -1); // первую выше двигать некуда
    expect((await allCategories())[0].id).toBe(cats[0].id);
  });
});

describe('шаблоны и бюджеты', () => {
  it('шаблон: создание, правка, порядок, удаление', async () => {
    const a = await saveTemplate({ name: ' Кофе ', amount: 25000, categoryId: 'cafe' });
    const b = await saveTemplate({ name: 'Метро', amount: 7000, categoryId: 'transport' });
    expect(a).toMatchObject({ name: 'Кофе', currency: 'RUB', order: 0 });
    expect(b.order).toBe(1);
    await moveTemplate(b.id, -1);
    expect((await allTemplates()).map((t) => t.name)).toEqual(['Метро', 'Кофе']);
    await saveTemplate({ id: a.id, name: 'Капучино', amount: 28000, categoryId: 'cafe' });
    expect(await db.templates.get(a.id)).toMatchObject({ name: 'Капучино', amount: 28000 });
    await deleteTemplate(b.id);
    expect((await allTemplates()).map((t) => t.name)).toEqual(['Капучино']);
  });

  it('трата из шаблона: имя в заметку, если не совпадает с категорией', async () => {
    const cats = new Map((await allCategories()).map((c) => [c.id, c]));
    const coffee = await saveTemplate({ name: 'Кофе', amount: 25000, categoryId: 'cafe' });
    const taxi = await saveTemplate({ name: 'такси', amount: 50000, categoryId: 'taxi' });
    const e1 = await addExpenseFromTemplate(coffee, cats.get('cafe')!, '2026-10-26');
    const e2 = await addExpenseFromTemplate(taxi, cats.get('taxi')!, '2026-10-26');
    expect(e1).toMatchObject({ amount: 25000, categoryId: 'cafe', note: 'Кофе', source: 'template', date: '2026-10-26' });
    expect(e2.note).toBe('');
  });

  it('бюджет: установка, замена, снятие', async () => {
    await setBudget('cafe', 1000000);
    await setBudget('cafe', 1500000);
    await setBudget('taxi', 500000);
    expect(await allBudgets()).toEqual([
      { categoryId: 'cafe', limit: 1500000 },
      { categoryId: 'taxi', limit: 500000 },
    ]);
    await setBudget('taxi', null);
    await setBudget('cafe', 0);
    expect(await allBudgets()).toEqual([]);
  });
});

describe('бэкап', () => {
  it('экспорт → восстановление возвращает данные один в один', async () => {
    await addCategory({ name: 'Спорт', emoji: '🏀', color: '#3b82f6' });
    await addExpense({ amount: 12345, categoryId: 'cafe', date: '2026-10-26', note: 'обед; "бизнес-ланч"' });
    await addExpense({ amount: 99, categoryId: 'other', date: '2026-01-01' });
    await addExpense({ amount: 2500, currency: 'USD', rate: 80.5381, rateSource: 'stale', categoryId: 'cafe', date: '2026-10-25' });
    await db.rates.put({ date: '2026-10-24', currency: 'USD', rate: 80.5381 });
    await setSetting('someFlag', true);
    await setSetting(SETTING_LAST_BACKUP, 1);

    const before = {
      categories: await db.categories.toArray(),
      expenses: await db.expenses.toArray(),
    };
    const json = JSON.stringify(await exportBackup(new Date('2026-10-26T10:00:00Z')));

    await db.delete();
    await db.open();
    await addExpense({ amount: 1, categoryId: 'cafe', date: '2026-10-26' }); // мусор, который должен исчезнуть

    await restoreBackup(parseBackup(json));
    expect(await db.categories.toArray()).toEqual(before.categories);
    expect(await db.expenses.toArray()).toEqual(before.expenses);
    expect((await db.expenses.toArray()).find((e) => e.currency === 'USD')).toMatchObject({ rateSource: 'stale', amountRub: 201345 });
    expect(await db.rates.toArray()).toEqual([{ date: '2026-10-24', currency: 'USD', rate: 80.5381 }]);
    expect(await getSetting('someFlag', false)).toBe(true);
    expect(await getSetting(SETTING_LAST_BACKUP, null)).toBe(Date.parse('2026-10-26T10:00:00Z'));
  });

  it('ключ пары не уходит в бэкап, а восстановление из бэкапа не рвёт связь с партнёром', async () => {
    const pairing = { pairId: 'p'.repeat(22), key: 'k'.repeat(43), deviceId: 'd'.repeat(22), createdAt: 1 };
    await db.settings.bulkPut([
      { key: 'pairing', value: pairing },
      { key: 'partner', value: { name: 'Аня' } },
      { key: 'syncPushHash', value: 'old' },
      { key: 'myName', value: 'Дима' },
    ]);
    await db.partnerExpenses.put({ id: 'p1', amount: 1, amountRub: 1, currency: 'RUB', rate: 1, categoryId: 'cafe', date: '2026-10-26', note: '', source: 'manual', createdAt: 1, updatedAt: 1 });
    const backup = await exportBackup();
    const text = JSON.stringify(backup);
    expect(text).not.toContain('k'.repeat(43));
    expect(text).not.toContain('partnerExpenses');
    expect(backup.tables.settings).toEqual([{ key: 'myName', value: 'Дима' }]);

    await restoreBackup(parseBackup(text));
    expect(await getSetting('pairing', null)).toEqual(pairing);
    expect(await getSetting('partner', null)).toEqual({ name: 'Аня' });
    expect(await getSetting('syncPushHash', null)).toBeNull(); // данные заменились — отправим заново
    expect(await db.partnerExpenses.count()).toBe(1);
  });

  it('отклоняет чужие и битые файлы понятной ошибкой', async () => {
    expect(() => parseBackup('не json')).toThrow('не JSON');
    expect(() => validateBackup({ foo: 1 })).toThrow('Это не бэкап');
    const good = await exportBackup();
    expect(() => validateBackup({ ...good, format: 99 })).toThrow('более новой версией');

    const withFloat = structuredClone(good);
    withFloat.tables.expenses = [
      { id: 'x', amount: 1.5, amountRub: 1, currency: 'RUB', rate: 1, categoryId: 'cafe', date: '2026-10-26', note: '', source: 'manual', createdAt: 1, updatedAt: 1 },
    ];
    expect(() => validateBackup(withFloat)).toThrow('копейках');

    const orphan = structuredClone(good);
    orphan.tables.expenses = [
      { id: 'x', amount: 1, amountRub: 1, currency: 'RUB', rate: 1, categoryId: 'nope', date: '2026-10-26', note: '', source: 'manual', createdAt: 1, updatedAt: 1 },
    ];
    expect(() => validateBackup(orphan)).toThrow('несуществующую категорию');
  });

  it('битый файл не трогает текущие данные', async () => {
    await addExpense({ amount: 500, categoryId: 'cafe', date: '2026-10-26' });
    expect(() => parseBackup('{"app":"rashody","format":1}')).toThrow();
    expect(await db.expenses.count()).toBe(1);
  });

  it('напоминание о бэкапе', () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    expect(needsBackupReminder(null, null, now)).toBe(false); // трат нет
    expect(needsBackupReminder(null, now - 3 * day, now)).toBe(false); // недавно начал
    expect(needsBackupReminder(null, now - 15 * day, now)).toBe(true); // две недели без бэкапа
    expect(needsBackupReminder(now - 10 * day, now - 60 * day, now)).toBe(false);
    expect(needsBackupReminder(now - 15 * day, now - 60 * day, now)).toBe(true);
  });

  it('CSV: разделитель «;», запятая в копейках, кавычки экранируются', async () => {
    await addExpense({ amount: 12345, categoryId: 'cafe', date: '2026-10-26', note: 'обед; "бизнес-ланч"' });
    await addExpense({ amount: 100000, categoryId: 'taxi', date: '2026-10-01' });
    const csv = expensesToCsv(await db.expenses.toArray(), await allCategories());
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines[0]).toBe('Дата;Сумма;Валюта;Сумма в рублях;Категория;Заметка;Источник');
    expect(lines[1]).toBe('2026-10-01;1000,00;RUB;1000,00;Такси;;manual');
    expect(lines[2]).toBe('2026-10-26;123,45;RUB;123,45;Кафе;"обед; ""бизнес-ланч""";manual');
  });
});
