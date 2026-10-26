// Чтение файла выписки в таблицу строк. SheetJS (XLSX/XLS) грузим только при импорте.

import { decodeBytes, parseCsv, type Grid } from './statement';

const pad = (n: number) => String(n).padStart(2, '0');

function cellToString(v: unknown): string {
  if (v instanceof Date) {
    // SheetJS с cellDates отдаёт дату в местном времени — как её и видно в Excel.
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}`;
  }
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

export function isSpreadsheet(name: string): boolean {
  return /\.(xlsx|xlsm|xls|xlsb|ods)$/i.test(name);
}

/** Excel → строки первого листа с данными. */
export async function readSpreadsheet(bytes: ArrayBuffer): Promise<Grid> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true, dense: true });
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    const grid = rows.map((r) => r.map(cellToString)).filter((r) => r.some((c) => c !== ''));
    if (grid.length > 1) return grid;
  }
  return [];
}

/** Любой поддерживаемый файл выписки → таблица строк. */
export async function readStatementFile(name: string, bytes: ArrayBuffer): Promise<Grid> {
  if (isSpreadsheet(name)) return readSpreadsheet(bytes);
  return parseCsv(decodeBytes(new Uint8Array(bytes)));
}
