// Как приложение видит файл выписки — без браузера, тем же кодом, что в приложении.
//
//   npx vite-node tools/check-statement.ts samples/*.csv samples/*.xlsx
//
// Печатает банк, выбранные колонки, что пропущено и первые строки с подобранными
// категориями. Настоящие выписки лежат в samples/ — она в .gitignore.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readStatementFile } from '../src/lib/spreadsheet';
import { findTable, guessMapping, isOwnTransfer, parseRows } from '../src/lib/statement';
import { suggestCategory } from '../src/lib/autocat';
import { DEFAULT_CATEGORIES } from '../src/db/seed';

const active = new Set(DEFAULT_CATEGORIES.map((c) => c.id));
const names = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c.name]));
const rub = (k: number) => (k / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2 });

for (const path of process.argv.slice(2)) {
  console.log(`\n=== ${basename(path)}`);
  const buf = readFileSync(path);
  const grid = await readStatementFile(path, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const table = findTable(grid);
  if (!table) {
    console.log('  ✗ таблица с датой и суммой не найдена. Первые строки файла:');
    grid.slice(0, 8).forEach((r) => console.log('   ', r.join(' | ')));
    continue;
  }
  const { mapping, confident, bank } = guessMapping(table);
  const col = (i: number | null) => (i === null ? '—' : `«${table.headers[i] ?? ''}» (№${i + 1})`);
  console.log(`  банк: ${bank ?? 'не узнан'} · колонки ${confident ? 'по названиям' : 'УГАДАНЫ по содержимому — проверить'}`);
  console.log(`  дата ${col(mapping.date)}, сумма ${col(mapping.amount)}, описание ${col(mapping.description)}, категория банка ${col(mapping.bankCategory)}, статус ${col(mapping.status)}, траты ${mapping.sign === 'negative' ? 'с минусом' : 'без знака'}`);
  const parsed = parseRows(table, mapping);
  const total = parsed.rows.reduce((s, r) => s + r.amount, 0);
  console.log(`  трат: ${parsed.rows.length} на ${rub(total)} ₽ · пропущено: поступления ${parsed.skippedIncome}, отклонённые ${parsed.skippedFailed}, служебные ${parsed.skippedInvalid}`);
  for (const r of parsed.rows.slice(0, 15)) {
    const s = suggestCategory(r.description, r.bankCategory, [], active);
    const flag = isOwnTransfer(r) ? '  [перевод себе — не загрузится]' : '';
    console.log(`   ${r.date}  ${rub(r.amount).padStart(12)}  ${r.description.slice(0, 32).padEnd(32)} → ${names.get(s.categoryId)} (${s.via}${r.bankCategory ? `: ${r.bankCategory}` : ''})${flag}`);
  }
  if (parsed.rows.length > 15) console.log(`   … ещё ${parsed.rows.length - 15}`);
}
