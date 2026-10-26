// Даты трат храним строкой 'YYYY-MM-DD' в местном времени — так сортировка и
// выборка по месяцу работают простым сравнением строк.

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function today(now: Date = new Date()): string {
  return toISODate(now);
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** Сколько дней от from до to ('2026-10-01' → '2026-10-03' = 2). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseISODate(to).getTime() - parseISODate(from).getTime()) / 86_400_000);
}

/** '2026-10-26' → '2026-10' */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Границы месяца: [первый день, первый день следующего месяца). */
export function monthRange(ym: string): [string, string] {
  return [`${ym}-01`, `${shiftMonth(ym, 1)}-01`];
}

export function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const monthFmt = new Intl.DateTimeFormat('ru-RU', { month: 'long' });

/** '2026-10' → 'Октябрь 2026' (год опускается для текущего года, если передан). */
export function formatMonth(ym: string, currentYm?: string): string {
  const [y, m] = ym.split('-').map(Number);
  const name = capitalize(monthFmt.format(new Date(y, m - 1, 1)));
  if (currentYm && currentYm.slice(0, 4) === ym.slice(0, 4)) return name;
  return `${name} ${y}`;
}

const dayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
const dayFmtYear = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });

/** «Сегодня», «Вчера», «пн, 24 октября», для прошлых лет — с годом. */
export function formatDay(iso: string, todayIso: string = today()): string {
  if (iso === todayIso) return 'Сегодня';
  if (iso === addDays(todayIso, -1)) return 'Вчера';
  const fmt = iso.slice(0, 4) === todayIso.slice(0, 4) ? dayFmt : dayFmtYear;
  return capitalize(fmt.format(parseISODate(iso)).replace(/\s?г\.$/, ''));
}

// Падежей месяцев Intl не даёт — держим свои.
const MONTH_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const monthIndex = (ym: string) => Number(ym.slice(5, 7)) - 1;

/** '2026-09' → 'сентябре' (для «в сентябре») */
export const monthPrepositional = (ym: string) => MONTH_PREP[monthIndex(ym)];
/** '2026-09' → 'сентября' (для «за те же дни сентября») */
export const monthGenitive = (ym: string) => MONTH_GEN[monthIndex(ym)];
/** '2026-09' → 'сен' */
export const monthShort = (ym: string) => MONTH_SHORT[monthIndex(ym)];

const shortFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });

/** '2026-10-24' → '24 октября' */
export function formatShortDate(iso: string): string {
  return shortFmt.format(parseISODate(iso));
}
