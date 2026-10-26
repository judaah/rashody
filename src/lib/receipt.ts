// QR-код кассового чека (формат ФНС): t=20261026T1530&s=1250.00&fn=…&i=…&fp=…&n=1
// t — дата и время, s — сумма, fn/i/fp — номер накопителя, документа и фискальный признак
// (вместе однозначно определяют чек), n — тип операции.

export interface Receipt {
  /** 'YYYY-MM-DD' — дата с кассы, местное время магазина. */
  date: string;
  /** 'HH:MM' */
  time: string;
  /** Сумма чека в копейках, всегда положительная. */
  amount: number;
  /** Возврат записываем минусом. */
  refund: boolean;
  /** Ключ для поиска повторно отсканированного чека. */
  externalId: string;
}

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/;
const SUM = /^(\d{1,9})(?:[.,](\d{1,2}))?$/;
const DIGITS = /^\d{1,20}$/;

/**
 * n: 1 — приход (покупка), 2 — возврат прихода, 3 — расход (магазин платит покупателю),
 * 4 — возврат расхода. Для покупателя деньги уходят при 1 и 4, приходят при 2 и 3.
 */
const REFUND_TYPES = new Set(['2', '3']);

/** Разбирает текст QR. null — это не QR кассового чека. */
export function parseReceiptQr(raw: string): Receipt | null {
  let text = raw.trim();
  // Некоторые кассы кладут ссылку на ОФД с параметрами после «?».
  const q = text.indexOf('?');
  if (q >= 0 && /[?&]t=/i.test(text)) text = text.slice(q + 1);

  const params = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(text)) params.set(key.toLowerCase().trim(), value.trim());

  const t = params.get('t')?.match(DATE_TIME);
  const s = params.get('s')?.match(SUM);
  const fn = params.get('fn') ?? '';
  const i = params.get('i') ?? '';
  const fp = params.get('fp') ?? '';
  const n = params.get('n') ?? '1';
  if (!t || !s || !DIGITS.test(fn) || !DIGITS.test(i) || !DIGITS.test(fp) || !/^[1-4]$/.test(n)) return null;

  const [, y, mo, d, hh, mm] = t;
  const probe = new Date(Number(y), Number(mo) - 1, Number(d));
  if (probe.getMonth() !== Number(mo) - 1 || probe.getDate() !== Number(d) || Number(hh) > 23 || Number(mm) > 59) return null;

  const amount = Number(s[1]) * 100 + Number((s[2] ?? '').padEnd(2, '0'));
  if (amount <= 0) return null;

  return {
    date: `${y}-${mo}-${d}`,
    time: `${hh}:${mm}`,
    amount,
    refund: REFUND_TYPES.has(n),
    externalId: `fns:${fn}:${i}:${fp}`,
  };
}
