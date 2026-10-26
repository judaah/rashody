import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Expense, Rule } from '../src/db/db';
import { DEFAULT_CATEGORIES } from '../src/db/seed';
import {
  decodeBytes,
  detectDelimiter,
  findTable,
  guessMapping,
  importIds,
  isOwnTransfer,
  matchManual,
  parseCsv,
  parseRows,
  parseStatementAmount,
  parseStatementDate,
  type StatementRow,
} from '../src/lib/statement';
import { readStatementFile } from '../src/lib/spreadsheet';
import { merchantKey, suggestCategory } from '../src/lib/autocat';

/** Windows-1251 без зависимостей: кириллица А–я, Ё/ё, №; остальное — ASCII. */
function cp1251(text: string): Uint8Array {
  return Uint8Array.from([...text].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c < 0x80) return c;
    if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
    if (ch === 'Ё') return 0xa8;
    if (ch === 'ё') return 0xb8;
    if (ch === '№') return 0xb9;
    throw new Error(`нет в cp1251: ${ch}`);
  }));
}

// Выписка в формате T-Банка (CSV, «;», кавычки, Windows-1251).
const TBANK = [
  '"Дата операции";"Дата платежа";"Номер карты";"Статус";"Сумма операции";"Валюта операции";"Сумма платежа";"Валюта платежа";"Кэшбэк";"Категория";"MCC";"Описание";"Бонусы (включая кэшбэк)";"Округление на инвесткопилку";"Сумма операции с округлением"',
  '"26.10.2026 18:47:12";"26.10.2026";"*1234";"OK";"-1342,50";"RUB";"-1342,50";"RUB";"";"Супермаркеты";"5411";"Пятёрочка";"13,00";"0,00";"1342,50"',
  '"26.10.2026 09:12:03";"26.10.2026";"*1234";"OK";"-250,00";"RUB";"-250,00";"RUB";"";"Фастфуд";"5814";"Кофемания";"2,00";"0,00";"250,00"',
  '"26.10.2026 09:12:40";"26.10.2026";"*1234";"OK";"-250,00";"RUB";"-250,00";"RUB";"";"Фастфуд";"5814";"Кофемания";"2,00";"0,00";"250,00"',
  '"25.10.2026 21:03:00";"25.10.2026";"*1234";"FAILED";"-5000,00";"RUB";"-5000,00";"RUB";"";"Переводы";"";"Иван П.";"0,00";"0,00";"5000,00"',
  '"25.10.2026 12:00:00";"25.10.2026";"";"OK";"85000,00";"RUB";"85000,00";"RUB";"";"Зарплата";"";"ООО Ромашка";"0,00";"0,00";"85000,00"',
  '"24.10.2026 19:30:00";"25.10.2026";"*1234";"OK";"-25,00";"USD";"-2013,45";"RUB";"";"Сервис";"5734";"STEAM GAMES";"0,00";"0,00";"2013,45"',
  '"24.10.2026 10:00:00";"24.10.2026";"";"OK";"-10000,00";"RUB";"-10000,00";"RUB";"";"Переводы";"";"Перевод между счетами";"0,00";"0,00";"10000,00"',
].join('\r\n');

const rowsOf = (text: string) => {
  const table = findTable(parseCsv(text))!;
  const guess = guessMapping(table);
  return { table, guess, parsed: parseRows(table, guess.mapping) };
};

describe('чтение файла', () => {
  it('Windows-1251 и UTF-8 с BOM читаются одинаково', () => {
    const fromCp = decodeBytes(cp1251(TBANK));
    const fromUtf = decodeBytes(new TextEncoder().encode('﻿' + TBANK));
    expect(fromCp).toBe(TBANK);
    expect(fromUtf).toBe(TBANK);
  });

  it('разделитель угадывается', () => {
    expect(detectDelimiter(TBANK)).toBe(';');
    expect(detectDelimiter('Дата,Сумма,Описание\n01.10.2026,"-1 250,50",Кафе')).toBe(',');
    expect(detectDelimiter('Дата\tСумма\tОписание\n01.10.2026\t-100\tКафе')).toBe('\t');
  });

  it('CSV: кавычки, «;» внутри кавычек, удвоенные кавычки, перенос строки', () => {
    expect(parseCsv('a;"b;c";"d ""e"""\r\n"x\ny";2;3', ';')).toEqual([
      ['a', 'b;c', 'd "e"'],
      ['x\ny', '2', '3'],
    ]);
  });
});

describe('значения', () => {
  it.each([
    ['26.10.2026 18:47:12', '2026-10-26'],
    ['01.02.26', '2026-02-01'],
    ['2026-10-26 18:47', '2026-10-26'],
    ['5/3/2026', '2026-03-05'],
    ['31.02.2026', null],
    ['Итого', null],
  ])('дата %s → %s', (cell, expected) => {
    expect(parseStatementDate(cell)).toBe(expected);
  });

  it.each([
    ['-1342,50', -134250],
    ['−1 342,50 ₽', -134250],
    ['1 342.5', 134250],
    ['(250,00)', -25000],
    ['1,234.56', 123456],
    ['1.234,56', 123456],
    ['+85000', 8500000],
    ['12 500', 1250000],
    ['', null],
    ['abc', null],
  ])('сумма %s → %s', (cell, expected) => {
    expect(parseStatementAmount(cell)).toBe(expected);
  });
});

describe('выписка T-Банка', () => {
  it('узнаёт банк и колонки: сумма платежа (в рублях), а не операции', () => {
    const { table, guess } = rowsOf(TBANK);
    expect(guess.bank).toBe('Т-Банк');
    expect(guess.confident).toBe(true);
    expect(table.headers[guess.mapping.date]).toBe('Дата операции');
    expect(table.headers[guess.mapping.amount]).toBe('Сумма платежа');
    expect(table.headers[guess.mapping.description]).toBe('Описание');
    expect(table.headers[guess.mapping.bankCategory!]).toBe('Категория');
    expect(guess.mapping.sign).toBe('negative');
  });

  it('берёт траты, пропускает отклонённые и поступления', () => {
    const { parsed } = rowsOf(TBANK);
    expect(parsed.rows.map((r) => [r.date, r.amount, r.description])).toEqual([
      ['2026-10-26', 134250, 'Пятёрочка'],
      ['2026-10-26', 25000, 'Кофемания'],
      ['2026-10-26', 25000, 'Кофемания'],
      ['2026-10-24', 201345, 'STEAM GAMES'],
      ['2026-10-24', 1000000, 'Перевод между счетами'],
    ]);
    expect(parsed).toMatchObject({ skippedFailed: 1, skippedIncome: 1, skippedInvalid: 0 });
  });

  it('перевод между своими счетами помечается', () => {
    const { parsed } = rowsOf(TBANK);
    expect(parsed.rows.map(isOwnTransfer)).toEqual([false, false, false, false, true]);
  });
});

describe('другие форматы', () => {
  it('шапка не в первой строке, колонка «Расход» без знака', () => {
    const csv = [
      'Выписка по счёту 40817810000000000001',
      'Период: 01.10.2026 — 31.10.2026',
      '',
      'Дата;Расход;Приход;Назначение платежа',
      '03.10.2026;1 250,00;;Оплата: ВКУСВИЛЛ',
      '05.10.2026;;50 000,00;Зарплата',
      '07.10.2026;380,00;;Оплата: Яндекс Такси',
      'Итого;1 630,00;50 000,00;',
    ].join('\n');
    const { guess, parsed } = rowsOf(csv);
    expect(guess.mapping.sign).toBe('positive');
    expect(parsed.rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-10-03', 125000],
      ['2026-10-07', 38000],
    ]);
    expect(parsed.skippedInvalid).toBe(2); // строка зарплаты без расхода и «Итого»
  });

  it('XLSX: даты-ячейки Excel и числа', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Дата операции', 'Сумма', 'Описание'],
      [new Date(2026, 9, 26, 18, 47), -1342.5, 'Пятёрочка'],
      [new Date(2026, 9, 25, 9, 0), -250, 'Кофемания'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Выписка');
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const grid = await readStatementFile('statement.xlsx', bytes);
    const { parsed } = (() => {
      const table = findTable(grid)!;
      return { parsed: parseRows(table, guessMapping(table).mapping) };
    })();
    expect(parsed.rows.map((r) => [r.date, r.amount, r.description])).toEqual([
      ['2026-10-26', 134250, 'Пятёрочка'],
      ['2026-10-25', 25000, 'Кофемания'],
    ]);
  });
});

describe('дубли', () => {
  const row = (index: number, date: string, amount: number, description = 'Кофемания'): StatementRow => ({
    index,
    date,
    amount,
    description,
    bankCategory: '',
  });

  it('ключи стабильны при повторной загрузке, одинаковые строки различаются', () => {
    const rows = rowsOf(TBANK).parsed.rows;
    const first = importIds(rows);
    expect(importIds(rowsOf(TBANK).parsed.rows)).toEqual(first);
    expect(new Set(first).size).toBe(first.length); // два одинаковых кофе — разные ключи
  });

  it('совпадение с ручной тратой: та же сумма, ±1 день, каждая трата один раз', () => {
    const manual = (id: string, date: string, amountRub: number, source: Expense['source'] = 'manual') =>
      ({ id, date, amountRub, source }) as Expense;
    const rows = [row(0, '2026-10-26', 25000), row(1, '2026-10-26', 25000), row(2, '2026-10-20', 25000), row(3, '2026-10-26', 99900)];
    const matches = matchManual(rows, [
      manual('a', '2026-10-25', 25000),
      manual('b', '2026-10-24', 25000), // два дня — уже не совпадение
      manual('c', '2026-10-26', 99900, 'import'), // импортированная — не «ручная»
    ]);
    expect([...matches.entries()].map(([i, e]) => [i, e.id])).toEqual([[0, 'a']]);
  });
});

describe('категории', () => {
  const active = new Set(DEFAULT_CATEGORIES.map((c) => c.id));

  it('ключ магазина без цифр, городов и юрформ', () => {
    expect(merchantKey('PYATEROCHKA 1234 MOSCOW RUS')).toBe('pyaterochka');
    expect(merchantKey('ООО «Ромашка» г. Москва')).toBe('ромашка');
    expect(merchantKey('Яндекс-Такси')).toBe('яндекс такси');
  });

  it('порядок: правило пользователя → категория банка → магазин → «Другое»', () => {
    const rules: Rule[] = [{ id: 'r1', pattern: 'кофемания', categoryId: 'fun' }];
    expect(suggestCategory('Кофемания', 'Фастфуд', rules, active)).toEqual({ categoryId: 'fun', via: 'rule' });
    expect(suggestCategory('Кофемания', 'Фастфуд', [], active)).toEqual({ categoryId: 'cafe', via: 'bank' });
    expect(suggestCategory('PYATEROCHKA 1234', '', [], active)).toEqual({ categoryId: 'groceries', via: 'merchant' });
    expect(suggestCategory('ООО Ромашка', '', [], active)).toEqual({ categoryId: 'other', via: 'none' });
  });

  it('словарь магазинов', () => {
    const cat = (d: string) => suggestCategory(d, '', [], active).categoryId;
    expect(cat('Оплата: ВКУСВИЛЛ')).toBe('groceries');
    expect(cat('Яндекс Такси')).toBe('taxi');
    expect(cat('МТС')).toBe('subscriptions');
    expect(cat('Мтсервис')).toBe('other'); // «мтс» только целым словом
    expect(cat('Аптека Ригла')).toBe('health');
    expect(cat('Шоколадница')).toBe('cafe');
  });

  it('размытая категория банка «Сервис» не перебивает магазин', () => {
    expect(suggestCategory('STEAM GAMES', 'Сервис', [], active)).toEqual({ categoryId: 'fun', via: 'merchant' });
  });

  it('правило длиннее — сильнее; архивная категория не подставляется', () => {
    const rules: Rule[] = [
      { id: 'a', pattern: 'яндекс', categoryId: 'subscriptions' },
      { id: 'b', pattern: 'яндекс такси', categoryId: 'taxi' },
    ];
    expect(suggestCategory('Яндекс Такси', '', rules, active).categoryId).toBe('taxi');
    const noTaxi = new Set([...active].filter((id) => id !== 'taxi'));
    expect(suggestCategory('Яндекс Такси', '', rules, noTaxi).categoryId).toBe('subscriptions');
  });
});
