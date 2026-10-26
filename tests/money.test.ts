import { describe, expect, it } from 'vitest';
import { applyKey, evalAmount, formatMoney, formatMoneyCompact, hasOperator, plural, minorToInput, type KeypadKey } from '../src/lib/money';

const type = (keys: KeypadKey[], start = '') => keys.reduce(applyKey, start);
// Intl ставит неразрывные пробелы — для сравнения приводим к обычным.
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('evalAmount', () => {
  it.each([
    ['', null],
    ['500', 50000],
    ['250,5', 25050],
    ['250,05', 25005],
    ['0,99', 99],
    ['500+250', 75000],
    ['1200−200', 100000],
    ['100−250', -15000],
    ['500+', 50000],
    ['500+250,5−0,5', 75000],
    ['1.5', 150],
    ['+500', null],
    ['500++1', null],
    ['1,234', null],
    ['abc', null],
  ])('%s → %s', (expr, expected) => {
    expect(evalAmount(expr)).toBe(expected);
  });
});

describe('applyKey', () => {
  it('набирает сумму с копейками', () => {
    expect(type(['2', '5', '0', ',', '5'])).toBe('250,5');
  });

  it('не даёт больше двух знаков после запятой и второй запятой', () => {
    expect(type(['1', ',', '2', '3', '4', ','])).toBe('1,23');
  });

  it('запятая в начале числа превращается в 0,', () => {
    expect(type([','])).toBe('0,');
    expect(type(['5', '+', ','])).toBe('5+0,');
  });

  it('убирает ведущий ноль', () => {
    expect(type(['0', '0', '7'])).toBe('7');
  });

  it('000 добавляется только к целой части', () => {
    expect(type(['5', '000'])).toBe('5000');
    expect(type(['000'])).toBe('');
    expect(type(['0', '000'])).toBe('0');
    expect(type(['5', ',', '000'])).toBe('5,');
  });

  it('оператор в начале игнорируется, повторный — заменяется', () => {
    expect(type(['+'])).toBe('');
    expect(type(['5', '+', '−'])).toBe('5−');
    expect(type(['5', ',', '+'])).toBe('5+');
  });

  it('ограничивает длину числа', () => {
    expect(type(Array(12).fill('9') as KeypadKey[])).toBe('999999999');
  });

  it('стирает и очищает', () => {
    expect(type(['1', '2', 'back'])).toBe('1');
    expect(type(['1', '2', 'clear'])).toBe('');
  });
});

describe('hasOperator', () => {
  it('видит операцию только после первого символа', () => {
    expect(hasOperator('500')).toBe(false);
    expect(hasOperator('500+2')).toBe(true);
    expect(hasOperator('−500')).toBe(false);
  });
});

describe('minorToInput', () => {
  it.each([
    [125000, '1250'],
    [125050, '1250,5'],
    [125005, '1250,05'],
    [99, '0,99'],
    [-15000, '−150'],
  ])('%i → %s', (minor, expected) => {
    expect(minorToInput(minor)).toBe(expected);
  });

  it('обратимо через evalAmount', () => {
    for (const v of [1, 10, 99, 100, 12345, 99999999]) expect(evalAmount(minorToInput(v))).toBe(v);
  });
});

describe('plural', () => {
  it.each([
    [1, 'трата'],
    [3, 'траты'],
    [5, 'трат'],
    [11, 'трат'],
    [21, 'трата'],
    [22, 'траты'],
  ])('%i %s', (n, word) => {
    expect(plural(n, 'трата', 'траты', 'трат')).toBe(word);
  });
});

describe('formatMoneyCompact', () => {
  it('мелкие суммы целиком, крупные — тыс./млн', () => {
    expect(plain(formatMoneyCompact(950050))).toBe('9 501 ₽');
    expect(plain(formatMoneyCompact(4530000))).toBe('45,3 тыс. ₽');
    expect(plain(formatMoneyCompact(125000000))).toBe('1,3 млн ₽');
  });
});

describe('formatMoney', () => {
  it('рубли без копеек и с копейками', () => {
    expect(plain(formatMoney(125000))).toBe('1 250 ₽');
    expect(plain(formatMoney(125050))).toBe('1 250,50 ₽');
    expect(plain(formatMoney(0))).toBe('0 ₽');
  });

  it('валюты — знаком, а не кодом', () => {
    expect(plain(formatMoney(500000, 'KZT'))).toBe('5 000 ₸');
    expect(plain(formatMoney(2550, 'USD'))).toBe('25,50 $');
    expect(plain(formatMoney(30000, 'THB'))).toBe('300 ฿');
  });
});
