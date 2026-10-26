import {
  db,
  DEVICE_ONLY_SETTINGS,
  SETTING_PAIRING,
  SETTING_PARTNER,
  TABLE_NAMES,
  type Category,
  type Expense,
  type Setting,
  type TableName,
} from '../db/db';
import { SETTING_LAST_BACKUP } from '../db/repo';

export const BACKUP_APP = 'rashody';
export const BACKUP_FORMAT = 1;

export interface BackupFile {
  app: typeof BACKUP_APP;
  format: number;
  exportedAt: string;
  tables: Record<TableName, unknown[]>;
}

const DAY = 24 * 60 * 60 * 1000;
export const BACKUP_REMIND_DAYS = 14;

export async function exportBackup(now: Date = new Date()): Promise<BackupFile> {
  return db.transaction('r', db.tables, async () => {
    const tables = {} as Record<TableName, unknown[]>;
    for (const name of TABLE_NAMES) tables[name] = await db.table(name).toArray();
    // Дата бэкапа внутри самого бэкапа бессмысленна, а ключ пары в файле в iCloud — лишний риск.
    tables.settings = (tables.settings as Array<{ key: string }>).filter(
      (s) => s.key !== SETTING_LAST_BACKUP && !DEVICE_ONLY_SETTINGS.includes(s.key),
    );
    return { app: BACKUP_APP, format: BACKUP_FORMAT, exportedAt: now.toISOString(), tables };
  });
}

export function backupFileName(now: Date = new Date()): string {
  const d = now.toISOString().slice(0, 10);
  return `rashody-backup-${d}.json`;
}

class BackupError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

function checkExpense(e: unknown, i: number): asserts e is Expense {
  const where = `трата №${i + 1}`;
  if (!isObj(e)) throw new BackupError(`Файл повреждён: ${where}`);
  if (!isStr(e.id) || !e.id) throw new BackupError(`Файл повреждён: ${where} без id`);
  if (!isInt(e.amount) || !isInt(e.amountRub)) throw new BackupError(`Файл повреждён: ${where}, сумма не в копейках`);
  if (!isStr(e.currency) || typeof e.rate !== 'number') throw new BackupError(`Файл повреждён: ${where}, валюта`);
  if (!isStr(e.categoryId)) throw new BackupError(`Файл повреждён: ${where}, категория`);
  if (!isStr(e.date) || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new BackupError(`Файл повреждён: ${where}, дата`);
  if (!isStr(e.note) || !isStr(e.source)) throw new BackupError(`Файл повреждён: ${where}`);
  if (!isInt(e.createdAt) || !isInt(e.updatedAt)) throw new BackupError(`Файл повреждён: ${where}, время`);
}

function checkCategory(c: unknown, i: number): asserts c is Category {
  if (!isObj(c) || !isStr(c.id) || !isStr(c.name) || !isStr(c.emoji) || !isStr(c.color) || !isInt(c.order) || typeof c.archived !== 'boolean') {
    throw new BackupError(`Файл повреждён: категория №${i + 1}`);
  }
}

/** Проверяет разобранный JSON и возвращает его как бэкап, иначе бросает ошибку с понятным текстом. */
export function validateBackup(data: unknown): BackupFile {
  if (!isObj(data) || data.app !== BACKUP_APP) throw new BackupError('Это не бэкап приложения «Расходы»');
  if (!isInt(data.format)) throw new BackupError('Файл повреждён: нет версии формата');
  if (data.format > BACKUP_FORMAT) throw new BackupError('Бэкап сделан более новой версией приложения — сначала обнови приложение');
  if (!isStr(data.exportedAt) || !isObj(data.tables)) throw new BackupError('Файл повреждён');
  const tables = data.tables;
  for (const name of TABLE_NAMES) {
    if (tables[name] === undefined) tables[name] = [];
    if (!Array.isArray(tables[name])) throw new BackupError(`Файл повреждён: раздел ${name}`);
  }
  const categories = tables.categories as unknown[];
  const expenses = tables.expenses as unknown[];
  categories.forEach(checkCategory);
  expenses.forEach(checkExpense);
  if (categories.length === 0) throw new BackupError('В бэкапе нет категорий');
  const catIds = new Set((categories as Category[]).map((c) => c.id));
  const orphan = (expenses as Expense[]).find((e) => !catIds.has(e.categoryId));
  if (orphan) throw new BackupError(`Файл повреждён: трата от ${orphan.date} ссылается на несуществующую категорию`);
  return data as unknown as BackupFile;
}

export function parseBackup(text: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError('Файл не читается: это не JSON');
  }
  return validateBackup(data);
}

/** Полностью заменяет мои данные на содержимое бэкапа. Связь с партнёром остаётся. */
export async function restoreBackup(backup: BackupFile): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    const pairing = await db.settings.get(SETTING_PAIRING);
    const partner = await db.settings.get(SETTING_PARTNER);
    for (const name of TABLE_NAMES) {
      const table = db.table(name);
      await table.clear();
      await table.bulkPut(name === 'settings' ? backup.tables.settings.filter((s) => !DEVICE_ONLY_SETTINGS.includes((s as Setting).key)) : backup.tables[name]);
    }
    if (pairing) await db.settings.put(pairing);
    if (partner) await db.settings.put(partner);
    // отпечаток последней отправки не восстанавливаем — данные поменялись, пусть уйдут партнёру
    await db.settings.put({ key: SETTING_LAST_BACKUP, value: Date.parse(backup.exportedAt) });
  });
}

/**
 * Пора ли напомнить про бэкап: последний был больше 14 дней назад,
 * а если не было ни одного — прошло 14 дней с первой траты.
 */
export function needsBackupReminder(lastBackupAt: number | null, firstExpenseAt: number | null, now: number = Date.now()): boolean {
  if (firstExpenseAt === null) return false;
  const since = lastBackupAt ?? firstExpenseAt;
  return now - since > BACKUP_REMIND_DAYS * DAY;
}

const csvCell = (v: string) => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvAmount = (minor: number) => (minor / 100).toFixed(2).replace('.', ',');

/** CSV для Excel/Numbers: разделитель «;», запятая в дробях, BOM для кириллицы. */
export function expensesToCsv(expenses: Expense[], categories: Category[]): string {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const header = ['Дата', 'Сумма', 'Валюта', 'Сумма в рублях', 'Категория', 'Заметка', 'Источник'];
  const rows = [...expenses]
    .sort((a, b) => (a.date === b.date ? a.createdAt - b.createdAt : a.date < b.date ? -1 : 1))
    .map((e) =>
      [e.date, csvAmount(e.amount), e.currency, csvAmount(e.amountRub), names.get(e.categoryId) ?? '', e.note, e.source]
        .map(csvCell)
        .join(';'),
    );
  return '﻿' + [header.join(';'), ...rows].join('\r\n') + '\r\n';
}
