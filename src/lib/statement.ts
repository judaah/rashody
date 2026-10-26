// Разбор банковской выписки (CSV/XLSX) в список трат. Всё чистые функции:
// файл → таблица строк → поиск шапки → какие колонки что значат → строки выписки.

import type { Expense } from '../db/db';
import { daysBetween } from './dates';

export type Grid = string[][];

export interface Table {
  headers: string[];
  rows: Grid;
}

export interface Mapping {
  date: number;
  amount: number;
  description: number;
  bankCategory: number | null;
  status: number | null;
  /** 'negative' — траты записаны с минусом (T-Банк), 'positive' — колонка «Расход» без знака. */
  sign: 'negative' | 'positive';
}

export interface StatementRow {
  /** Номер строки в таблице — стабилен для одного файла. */
  index: number;
  date: string;
  /** Сумма траты в копейках, всегда > 0. */
  amount: number;
  description: string;
  bankCategory: string;
}

export interface ParsedStatement {
  rows: StatementRow[];
  /** Поступления: зарплата, возвраты, переводы вам. */
  skippedIncome: number;
  /** Отклонённые банком операции. */
  skippedFailed: number;
  /** Строки без даты или суммы: итоги, пустые, подписи. */
  skippedInvalid: number;
}

// ---------- текст ----------

/** UTF-8, а если байты в нём невалидны — Windows-1251 (так выгружают многие банки). */
export function decodeBytes(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1251').decode(bytes);
  }
  return text.replace(/^﻿/, '');
}

/** Разделитель — тот, что даёт одинаковое и наибольшее число колонок в первых строках. */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best = ';';
  let bestScore = -1;
  for (const d of [';', ',', '\t', '|']) {
    const counts = lines.map((l) => splitCsvLine(l, d).length);
    const max = Math.max(...counts);
    if (max < 2) continue;
    const consistent = counts.filter((c) => c === max).length;
    const score = consistent * 100 + max;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function splitCsvLine(line: string, d: string): string[] {
  return parseCsv(line, d)[0] ?? [];
}

/** CSV по RFC 4180: кавычки, удвоенные кавычки, переносы строк внутри кавычек. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): Grid {
  const rows: Grid = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

// ---------- значения ----------

/** Дата из ячейки выписки → 'YYYY-MM-DD'. Время отбрасываем. */
export function parseStatementDate(cell: string): string | null {
  const s = cell.trim();
  let y: number, m: number, d: number;
  let match = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})(?:\D|$)/);
  if (match) {
    d = Number(match[1]);
    m = Number(match[2]);
    y = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  } else if ((match = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\D|$)/))) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else return null;
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d || y < 2000) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** «-1 250,50», «−1250.50 ₽», «(1 250,50)», «1,234.56» → копейки со знаком. */
export function parseStatementAmount(cell: string): number | null {
  let s = cell.trim().replace(/[\s  ']/g, '').replace(/−/g, '-');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^\d.,+-]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d[\d.,]*$/.test(s)) return null;
  // Десятичный разделитель — последний из «.» и «,», если после него 1–2 цифры.
  const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  let int = s;
  let frac = '';
  if (lastSep >= 0 && s.length - lastSep - 1 <= 2) {
    int = s.slice(0, lastSep);
    frac = s.slice(lastSep + 1);
  }
  int = int.replace(/[.,]/g, '');
  if (!/^\d+$/.test(int || '0') || !/^\d{0,2}$/.test(frac)) return null;
  const value = Number(int || '0') * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -value : value;
}

// ---------- шапка и колонки ----------

const norm = (h: string) => h.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Ищем строку-шапку: в ней есть «дата» и «сумма»/«расход». Выше бывают реквизиты счёта. */
export function findTable(grid: Grid): Table | null {
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const cells = grid[i].map(norm);
    const filled = cells.filter(Boolean).length;
    if (filled >= 3 && cells.some((c) => c.includes('дата')) && cells.some((c) => /сумм|расход|списан|amount/.test(c))) {
      return { headers: grid[i], rows: grid.slice(i + 1) };
    }
  }
  return null;
}

function pick(headers: string[], patterns: RegExp[], exclude?: RegExp): number {
  const h = headers.map(norm);
  for (const p of patterns) {
    const idx = h.findIndex((x) => p.test(x) && !exclude?.test(x));
    if (idx >= 0) return idx;
  }
  return -1;
}

function share(rows: Grid, col: number, test: (v: string) => boolean): number {
  const sample = rows.slice(0, 200).filter((r) => (r[col] ?? '') !== '');
  return sample.length ? sample.filter((r) => test(r[col])).length / sample.length : 0;
}

export interface GuessedMapping {
  mapping: Mapping;
  /** Все три главные колонки найдены по названиям — настройку можно не показывать. */
  confident: boolean;
  /** Узнанный банк, если формат знакомый. */
  bank: string | null;
}

export function guessMapping(table: Table): GuessedMapping {
  const { headers, rows } = table;
  const width = Math.max(headers.length, ...rows.slice(0, 50).map((r) => r.length));
  const cols = Array.from({ length: width }, (_, i) => i);

  let date = pick(headers, [/дата (совершения )?операции/, /^дата$/, /^date$/, /дата/]);
  const amountByName = pick(
    headers,
    [/сумма платежа/, /сумма в валюте (счета|карты)/, /сумма операции/, /^сумма$/, /сумма/, /amount/],
    /кэшбэк|кешбэк|бонус|округлен|комисси|остаток/,
  );
  const outflow = pick(headers, [/^расход/, /списани/, /дебет/]);
  let amount = amountByName >= 0 ? amountByName : outflow;
  let description = pick(headers, [/^описание/, /описание/, /назначение/, /наименование|контрагент|получатель|место|merchant|description/]);
  const bankCategory = pick(headers, [/категори/]);
  const status = pick(headers, [/статус/]);

  const confident = date >= 0 && amount >= 0 && description >= 0;
  // Чего нет в названиях — угадываем по содержимому колонок.
  if (date < 0) date = cols.find((c) => share(rows, c, (v) => parseStatementDate(v) !== null) > 0.8) ?? 0;
  if (amount < 0) amount = cols.find((c) => c !== date && share(rows, c, (v) => parseStatementAmount(v) !== null) > 0.8) ?? 1;
  if (description < 0) {
    description =
      cols.find((c) => c !== date && c !== amount && share(rows, c, (v) => /[a-zа-яё]{3}/i.test(v) && parseStatementDate(v) === null) > 0.6) ?? 2;
  }

  const hasNegative = share(rows, amount, (v) => (parseStatementAmount(v) ?? 0) < 0) > 0;
  const sign: Mapping['sign'] = amount === outflow && amountByName < 0 ? 'positive' : hasNegative ? 'negative' : 'positive';

  const h = headers.map(norm);
  const bank = h.includes('номер карты') && h.some((x) => x.startsWith('кэшбэк') || x.startsWith('кешбэк')) && h.includes('mcc') ? 'Т-Банк' : null;

  return {
    mapping: { date, amount, description, bankCategory: bankCategory >= 0 ? bankCategory : null, status: status >= 0 ? status : null, sign },
    confident,
    bank,
  };
}

/** Отпечаток шапки — по нему узнаём выписку того же банка в следующий раз. */
export function headerSignature(headers: string[]): string {
  return headers.map(norm).join('|');
}

const FAILED = /fail|отклон|отмен|ошибк|declin|reject/i;

export function parseRows(table: Table, m: Mapping): ParsedStatement {
  const result: ParsedStatement = { rows: [], skippedIncome: 0, skippedFailed: 0, skippedInvalid: 0 };
  table.rows.forEach((r, index) => {
    const date = parseStatementDate(r[m.date] ?? '');
    const raw = parseStatementAmount(r[m.amount] ?? '');
    if (!date || raw === null || raw === 0) {
      result.skippedInvalid++;
      return;
    }
    if (m.status !== null && FAILED.test(r[m.status] ?? '')) {
      result.skippedFailed++;
      return;
    }
    const spend = m.sign === 'negative' ? -raw : raw;
    if (spend <= 0) {
      result.skippedIncome++;
      return;
    }
    result.rows.push({
      index,
      date,
      amount: spend,
      description: (r[m.description] ?? '').replace(/\s+/g, ' ').trim(),
      bankCategory: m.bankCategory !== null ? (r[m.bankCategory] ?? '').trim() : '',
    });
  });
  return result;
}

// ---------- дубли ----------

/** FNV-1a — короткий стабильный хеш строки. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Ключ строки выписки. Одинаковые строки (два кофе за 250 ₽ в один день) различаются
 * порядковым номером, поэтому повторная загрузка того же файла даёт те же ключи.
 */
export function importIds(rows: StatementRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.date}|${r.amount}|${norm(r.description)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `imp:${hash(`${base}|${n}`)}`;
  });
}

/**
 * Траты, уже записанные руками (или из чека), которые совпадают со строкой выписки:
 * та же сумма в рублях, дата ±1 день. Каждая ручная трата сопоставляется не больше одного раза.
 */
export function matchManual(rows: StatementRow[], existing: Expense[]): Map<number, Expense> {
  const pool = existing.filter((e) => e.source !== 'import' && e.amountRub > 0);
  const used = new Set<string>();
  const result = new Map<number, Expense>();
  const byDistance = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const row of byDistance) {
    let best: Expense | undefined;
    let bestDist = 2;
    for (const e of pool) {
      if (used.has(e.id) || e.amountRub !== row.amount) continue;
      const dist = Math.abs(daysBetween(e.date, row.date));
      if (dist < bestDist) {
        best = e;
        bestDist = dist;
      }
    }
    if (best) {
      used.add(best.id);
      result.set(row.index, best);
    }
  }
  return result;
}

/** Переводы между своими счетами — не трата, по умолчанию не загружаем. */
export function isOwnTransfer(row: StatementRow): boolean {
  const text = `${row.description} ${row.bankCategory}`.toLowerCase().replace(/ё/g, 'е');
  return /между (своими )?счетами|перевод себе|на свой сч|пополнение (вклада|копилки|накопит|брокер)|на накопительный|инвесткопилк|погашение кредит/.test(text);
}
