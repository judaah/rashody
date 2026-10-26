// Валюта просмотра: в ней показываются итоги, суммы по дням и категориям, отчёты и бюджеты.
// Внутри всё хранится в рублях (копейках) — пересчёт только при показе, по последнему курсу ЦБ.

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { formatMoney, formatMoneyCompact, RUB } from '../lib/money';

export const SETTING_DISPLAY_CURRENCY = 'displayCurrency';

export interface DisplayCurrency {
  code: string;
  /** Рублей за 1 единицу валюты; у рубля — 1. */
  rate: number;
  /** Дата курса ЦБ; null у рубля. */
  rateDate: string | null;
}

export const RUB_DISPLAY: DisplayCurrency = { code: RUB, rate: 1, rateDate: null };

const Ctx = createContext<DisplayCurrency>(RUB_DISPLAY);
export const DisplayCurrencyProvider = Ctx.Provider;

/** Рубли (копейки) → валюта просмотра (её минорные единицы). */
export const toDisplay = (rubMinor: number, d: DisplayCurrency) => (d.code === RUB ? rubMinor : Math.round(rubMinor / d.rate));

export function useMoney() {
  const d = useContext(Ctx);
  return {
    code: d.code,
    rateDate: d.rateDate,
    /** Сумма в рублях → строка в валюте просмотра. */
    fmt: (rubMinor: number) => formatMoney(toDisplay(rubMinor, d), d.code),
    fmtCompact: (rubMinor: number) => formatMoneyCompact(toDisplay(rubMinor, d), d.code),
  };
}
