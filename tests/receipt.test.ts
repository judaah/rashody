import { beforeEach, describe, expect, it } from 'vitest';
import { parseReceiptQr } from '../src/lib/receipt';
import { db } from '../src/db/db';
import { addExpense, findByExternalId } from '../src/db/repo';

// Типичная строка из QR кассового чека.
const QR = 't=20261026T1530&s=1250.00&fn=7380440700076549&i=41975&fp=2026064292&n=1';

describe('QR чека ФНС', () => {
  it('покупка: дата, время, сумма в копейках, ключ чека', () => {
    expect(parseReceiptQr(QR)).toEqual({
      date: '2026-10-26',
      time: '15:30',
      amount: 125000,
      refund: false,
      externalId: 'fns:7380440700076549:41975:2026064292',
    });
  });

  it.each([
    ['время с секундами', 't=20261026T153045&s=99.9&fn=1&i=2&fp=3&n=1', { time: '15:30', amount: 9990 }],
    ['сумма без копеек', 't=20261026T0905&s=380&fn=1&i=2&fp=3&n=1', { time: '09:05', amount: 38000 }],
    ['запятая в сумме', 't=20261026T0905&s=12,5&fn=1&i=2&fp=3&n=1', { amount: 1250 }],
    ['поля в другом порядке, без n', 'fn=1&fp=3&i=2&s=10.00&t=20260101T0000', { date: '2026-01-01', refund: false }],
    ['ключи большими буквами и пробелы', '  T=20261026T1530&S=10.00&FN=1&I=2&FP=3&N=1\n', { amount: 1000 }],
    ['ссылка ОФД с параметрами', 'https://check.example.ru/?t=20261026T1530&s=10.00&fn=1&i=2&fp=3&n=1', { amount: 1000 }],
  ])('%s', (_name, text, expected) => {
    expect(parseReceiptQr(text)).toMatchObject(expected);
  });

  it('возврат прихода (n=2) и расход (n=3) — деньги вернулись', () => {
    expect(parseReceiptQr(QR.replace('n=1', 'n=2'))?.refund).toBe(true);
    expect(parseReceiptQr(QR.replace('n=1', 'n=3'))?.refund).toBe(true);
    expect(parseReceiptQr(QR.replace('n=1', 'n=4'))?.refund).toBe(false);
  });

  it.each([
    ['ссылка без чека', 'https://example.com'],
    ['пустая строка', ''],
    ['нет суммы', 't=20261026T1530&fn=1&i=2&fp=3&n=1'],
    ['нулевая сумма', QR.replace('s=1250.00', 's=0.00')],
    ['три знака после точки', QR.replace('s=1250.00', 's=1250.005')],
    ['31 ноября', QR.replace('20261026', '20261131')],
    ['25 часов', QR.replace('T1530', 'T2530')],
    ['нет fp', 't=20261026T1530&s=10&fn=1&i=2&n=1'],
    ['неизвестный тип', QR.replace('n=1', 'n=7')],
  ])('%s → не чек', (_name, text) => {
    expect(parseReceiptQr(text)).toBeNull();
  });
});

describe('повторный чек', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('находится по ключу чека', async () => {
    const receipt = parseReceiptQr(QR)!;
    expect(await findByExternalId(receipt.externalId)).toBeUndefined();
    await addExpense({ amount: receipt.amount, categoryId: 'groceries', date: receipt.date, source: 'qr', externalId: receipt.externalId });
    expect(await findByExternalId(receipt.externalId)).toMatchObject({ amount: 125000, source: 'qr' });
  });
});
