import Dexie, { type EntityTable } from 'dexie';
import { DEFAULT_CATEGORIES } from './seed';

export interface Category {
  id: string;
  name: string;
  emoji: string;
  color: string;
  order: number;
  archived: boolean;
}

export type ExpenseSource = 'manual' | 'template' | 'qr' | 'import';

/** Откуда курс у валютной траты: ЦБ на дату, последний сохранённый (не было сети) или введён руками. */
export type RateSource = 'cbr' | 'stale' | 'manual';

export interface Expense {
  id: string;
  /** Сумма в валюте траты, в минорных единицах. Возврат — отрицательная. */
  amount: number;
  currency: string;
  /** Та же сумма в рублях (копейки) — по ней считаются отчёты и бюджеты. */
  amountRub: number;
  /** Рублей за единицу валюты на дату траты; для рубля — 1. */
  rate: number;
  /** Только у валютных трат. 'stale' пересчитывается сам, когда появится сеть. */
  rateSource?: RateSource;
  categoryId: string;
  /** 'YYYY-MM-DD', местное время. */
  date: string;
  note: string;
  source: ExpenseSource;
  /** Ключ для поиска дублей: fn+i+fp чека или хеш строки выписки. */
  externalId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Budget {
  categoryId: string;
  /** Месячный лимит, копейки. */
  limit: number;
}

export interface Template {
  id: string;
  name: string;
  amount: number;
  currency: string;
  categoryId: string;
  order: number;
}

export interface Rule {
  id: string;
  /** Подстрока описания операции в выписке, в нижнем регистре. */
  pattern: string;
  categoryId: string;
}

export interface ImportProfile {
  id: string;
  name: string;
  /** Отпечаток заголовка файла, по нему профиль находится сам. */
  signature: string;
  mapping: Record<string, unknown>;
}

export interface Rate {
  date: string;
  currency: string;
  /** Рублей за единицу валюты. */
  rate: number;
}

export interface Setting {
  key: string;
  value: unknown;
}

export const TABLE_NAMES = [
  'categories',
  'expenses',
  'budgets',
  'templates',
  'rules',
  'importProfiles',
  'rates',
  'settings',
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

export class RashodyDB extends Dexie {
  categories!: EntityTable<Category, 'id'>;
  expenses!: EntityTable<Expense, 'id'>;
  budgets!: EntityTable<Budget, 'categoryId'>;
  templates!: EntityTable<Template, 'id'>;
  rules!: EntityTable<Rule, 'id'>;
  importProfiles!: EntityTable<ImportProfile, 'id'>;
  rates!: Dexie.Table<Rate, [string, string]>;
  settings!: EntityTable<Setting, 'key'>;

  constructor(name = 'rashody') {
    super(name);
    // Схема сразу под все этапы спеки, чтобы не плодить миграции.
    // Новые поля/индексы — только через this.version(2) с upgrade().
    this.version(1).stores({
      categories: 'id, order',
      expenses: 'id, date, categoryId, externalId, createdAt',
      budgets: 'categoryId',
      templates: 'id, order',
      rules: 'id, categoryId',
      importProfiles: 'id, signature',
      rates: '[date+currency], currency',
      settings: 'key',
    });
    this.on('populate', (tx) => {
      tx.table('categories').bulkAdd(DEFAULT_CATEGORIES);
    });
  }
}

export const db = new RashodyDB();
