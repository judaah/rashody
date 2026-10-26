import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  daysInMonth,
  formatDay,
  formatMonth,
  monthGenitive,
  monthPrepositional,
  monthRange,
  monthShort,
  shiftMonth,
  toISODate,
} from '../src/lib/dates';

describe('даты', () => {
  it('toISODate берёт местную дату, а не UTC', () => {
    expect(toISODate(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01');
    expect(toISODate(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });

  it('addDays переходит через месяц и год', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('shiftMonth и monthRange', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(monthRange('2026-12')).toEqual(['2026-12-01', '2027-01-01']);
  });

  it('daysBetween не сбивается на переходе на летнее время', () => {
    expect(daysBetween('2026-10-01', '2026-10-03')).toBe(2);
    expect(daysBetween('2026-10-26', '2026-10-26')).toBe(0);
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('daysInMonth', () => {
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-10')).toBe(31);
  });

  it('formatDay: сегодня, вчера, дата', () => {
    expect(formatDay('2026-10-26', '2026-10-26')).toBe('Сегодня');
    expect(formatDay('2026-10-25', '2026-10-26')).toBe('Вчера');
    expect(formatDay('2026-10-24', '2026-10-26')).toMatch(/^Сб, 24 октября$/);
    expect(formatDay('2025-12-31', '2026-10-26')).toMatch(/31 декабря 2025/);
  });

  it('падежи и короткие названия месяцев', () => {
    expect(monthPrepositional('2026-09')).toBe('сентябре');
    expect(monthGenitive('2026-05')).toBe('мая');
    expect(monthShort('2026-12')).toBe('дек');
  });

  it('formatMonth в именительном падеже', () => {
    expect(formatMonth('2026-10')).toBe('Октябрь 2026');
    expect(formatMonth('2026-05', '2026-10')).toBe('Май');
  });
});
