// Деньги везде храним целыми копейками (минорные единицы), без дробных чисел.

export const RUB = 'RUB';

const MINUS = '−'; // U+2212, так рисуем минус на клавиатуре
const MAX_INT_DIGITS = 9;

/** "250,5" → 25050. Строка уже проверена регуляркой. */
function numberToMinor(token: string): number {
  const [int = '', frac = ''] = token.split('.');
  return Number(int || '0') * 100 + Number((frac + '00').slice(0, 2));
}

/**
 * Считает выражение с клавиатуры ("500+250,5", "1200−200") в копейки.
 * Хвостовой оператор игнорируется, пока человек печатает ("500+" → 50000).
 * null — если чисел нет или выражение кривое.
 */
export function evalAmount(expr: string): number | null {
  const normalized = expr.replace(/\s/g, '').replace(/,/g, '.').replace(new RegExp(MINUS, 'g'), '-');
  if (!normalized) return null;
  const tokens = normalized.split(/([+-])/).filter((t) => t !== '');
  let total = 0;
  let sign = 1;
  let seenNumber = false;
  let expectNumber = true;
  for (const t of tokens) {
    if (t === '+' || t === '-') {
      if (expectNumber) return null;
      sign = t === '+' ? 1 : -1;
      expectNumber = true;
      continue;
    }
    if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(t)) return null;
    total += sign * numberToMinor(t);
    seenNumber = true;
    expectNumber = false;
  }
  return seenNumber ? total : null;
}

export type KeypadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '000' | ',' | '+' | '−' | 'back' | 'clear';

const isOperator = (ch: string) => ch === '+' || ch === MINUS;

/** Применяет нажатие клавиши к строке выражения. Невозможные нажатия просто игнорируются. */
export function applyKey(expr: string, key: KeypadKey): string {
  if (key === 'clear') return '';
  if (key === 'back') return expr.slice(0, -1);

  const last = expr.slice(-1);
  const opIndex = Math.max(expr.lastIndexOf('+'), expr.lastIndexOf(MINUS));
  const current = expr.slice(opIndex + 1); // число, которое сейчас набирается
  const [intPart, fracPart] = current.split(',');

  if (key === '+' || key === '−') {
    if (!expr) return expr;
    if (isOperator(last)) return expr.slice(0, -1) + key;
    if (last === ',') return expr.slice(0, -1) + key;
    return expr + key;
  }

  if (key === ',') {
    if (fracPart !== undefined) return expr;
    return current === '' ? expr + '0,' : expr + ',';
  }

  if (key === '000') {
    if (fracPart !== undefined || intPart === '' || intPart === '0') return expr;
    if (intPart.length + 3 > MAX_INT_DIGITS) return expr;
    return expr + '000';
  }

  // цифра
  if (fracPart !== undefined) {
    return fracPart.length >= 2 ? expr : expr + key;
  }
  if (intPart === '0') return expr.slice(0, -1) + key; // "0" → "5", без ведущих нулей
  if (intPart.length >= MAX_INT_DIGITS) return expr;
  return expr + key;
}

/** Есть ли в выражении операция — тогда показываем строку выражения над итогом. */
export function hasOperator(expr: string): boolean {
  return /[+−]/.test(expr.slice(1));
}

/** Копейки → строка для поля ввода ("1250,5" → "1250,5"; 125000 → "1250"). */
export function minorToInput(minor: number): string {
  const abs = Math.abs(minor);
  const int = Math.floor(abs / 100);
  const frac = abs % 100;
  const fracStr = frac === 0 ? '' : ',' + String(frac).padStart(2, '0').replace(/0$/, '');
  return (minor < 0 ? MINUS : '') + int + fracStr;
}

const pluralRules = new Intl.PluralRules('ru-RU');

/** plural(5, 'трата', 'траты', 'трат') → 'трат' */
export function plural(n: number, one: string, few: string, many: string): string {
  const form = pluralRules.select(n);
  return form === 'one' ? one : form === 'few' ? few : many;
}

const compactFmt =new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });

/** Короткая подпись для графиков: 4530000 → «45,3 тыс. ₽», мелкие суммы — как есть, без копеек. */
export function formatMoneyCompact(minor: number): string {
  const rub = Math.round(minor / 100);
  return Math.abs(rub) < 10_000 ? formatMoney(rub * 100) : `${compactFmt.format(rub)} ₽`;
}

const formatters = new Map<string, Intl.NumberFormat>();

/** 125050 → "1 250,50 ₽", 125000 → "1 250 ₽". */
export function formatMoney(minor: number, currency: string = RUB): string {
  const fraction = minor % 100 !== 0 ? 2 : 0;
  const key = `${currency}:${fraction}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol', // «₸», «$» вместо «KZT», «US$»
      minimumFractionDigits: fraction,
      maximumFractionDigits: fraction,
    });
    formatters.set(key, fmt);
  }
  return fmt.format(minor / 100);
}
