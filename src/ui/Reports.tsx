import { useState } from 'preact/hooks';
import type { Category } from '../db/db';
import { scopedBetween, type Scope } from '../db/scope';
import { OTHER_COLOR } from '../db/seed';
import { formatMonth, monthGenitive, monthOf, monthPrepositional, monthRange, monthShort, shiftMonth } from '../lib/dates';
import {
  comparePeriods,
  donutSegments,
  donutSlices,
  inRange,
  monthsEndingAt,
  percentChange,
  REST_ID,
  sumByCategory,
  sumRub,
  totalsByMonth,
} from '../lib/stats';
import { useLive, useToday } from '../lib/hooks';
import { EmptyState } from './common';
import { useMoney } from './displayMoney';
import { IconBack, IconChevron } from './icons';

type Span = 6 | 12;

export function Reports({
  categories,
  onOpenCategory,
  scope,
}: {
  categories: Map<string, Category>;
  onOpenCategory: (categoryId: string, ym: string) => void;
  scope: Scope;
}) {
  const money = useMoney();
  const today = useToday();
  const currentYm = monthOf(today);
  const [ym, setYm] = useState(currentYm);
  const [span, setSpan] = useState<Span>(6);
  // Окно столбиков двигается только стрелками месяца — нажатие на столбик его не сдвигает.
  const [windowEnd, setWindowEnd] = useState(currentYm);
  const months = monthsEndingAt(windowEnd, span);

  const clampEnd = (m: string) => (m > currentYm ? currentYm : m);
  const goTo = (next: string) => {
    setYm(next);
    if (next > windowEnd) setWindowEnd(next);
    else if (next < months[0]) setWindowEnd(clampEnd(shiftMonth(next, span - 1)));
  };
  const changeSpan = (n: Span) => {
    setSpan(n);
    // Окно заканчивается как можно ближе к текущему месяцу, но выбранный остаётся внутри.
    setWindowEnd(clampEnd(shiftMonth(ym, n - 1)));
  };

  const from = [months[0], shiftMonth(ym, -1)].sort()[0];
  const data = useLive(() => scopedBetween(monthRange(from)[0], monthRange(windowEnd)[1], scope), [from, windowEnd, scope]);
  if (!data) return null;

  const cmp = comparePeriods(ym, today);
  const monthExpenses = data.filter((e) => monthOf(e.date) === ym);
  const total = sumRub(monthExpenses);
  const currentForCmp = sumRub(data.filter((e) => inRange(e, cmp.current)));
  const previous = data.filter((e) => inRange(e, cmp.previous));
  const previousTotal = sumRub(previous);
  const change = percentChange(currentForCmp, previousTotal);

  const sums = sumByCategory(monthExpenses);
  const prevSums = sumByCategory(previous);
  const slices = donutSlices(sums, categories);
  const segments = donutSegments(slices, 0.6);
  const sliceColor = new Map<string, string>();
  for (const s of slices) for (const id of s.categoryIds) sliceColor.set(id, s.id === REST_ID ? OTHER_COLOR : s.color);
  const positiveTotal = slices.reduce((s, x) => s + x.value, 0);
  const rows = [...sums.entries()].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);

  const totals = totalsByMonth(data);
  const values = months.map((m) => Math.max(0, totals.get(m) ?? 0));
  const maxValue = Math.max(1, ...values);
  // Среднее — по месяцам с тратами, без текущего недоделанного месяца.
  const complete = months.filter((m, i) => values[i] > 0 && m !== currentYm);
  const average = complete.length
    ? Math.round(complete.reduce((s, m) => s + (totals.get(m) ?? 0), 0) / complete.length / 100) * 100 // до рубля
    : null;

  const prevYm = shiftMonth(ym, -1);
  const prevLabel = cmp.partial ? `за те же дни ${monthGenitive(prevYm)}` : `в ${monthPrepositional(prevYm)}`;

  return (
    <div class="screen-body">
      <header class="screen-head">
        <div class="month-switch">
          <button class="icon-btn" onClick={() => goTo(shiftMonth(ym, -1))} aria-label="Предыдущий месяц">
            <IconBack />
          </button>
          <span class="month-title">{formatMonth(ym, currentYm)}</span>
          <button class="icon-btn" onClick={() => goTo(shiftMonth(ym, 1))} disabled={ym >= currentYm} aria-label="Следующий месяц">
            <IconChevron />
          </button>
        </div>
        <div class="month-total" data-testid="report-total">
          {money.fmt(total)}
        </div>
        <div class="compare" data-testid="report-compare">
          {previousTotal === 0 ? (
            <span class="muted">Сравнить не с чем: {prevLabel} трат нет</span>
          ) : change === 0 ? (
            <span>Столько же, сколько {prevLabel}</span>
          ) : (
            <span class={change! > 0 ? 'danger' : 'good'}>
              {change! > 0 ? '▲' : '▼'} на {Math.abs(change!)}% {change! > 0 ? 'больше' : 'меньше'}, чем {prevLabel}
              <span class="muted"> ({money.fmt(previousTotal)})</span>
            </span>
          )}
        </div>
      </header>

      {rows.length === 0 ? (
        <EmptyState title="Трат нет" text={`В ${monthPrepositional(ym)} ничего не записано.`} />
      ) : (
        <>
          {segments.length > 0 && (
            <div class="donut-wrap">
              <svg viewBox="0 0 120 120" class="donut" role="img" aria-label="Доли категорий за месяц, подробности в списке ниже">
                {segments.map((s) => (
                  <circle
                    key={s.id}
                    cx="60"
                    cy="60"
                    r="48"
                    fill="none"
                    stroke={s.color}
                    stroke-width="16"
                    pathLength={100}
                    stroke-dasharray={`${s.length} ${100 - s.length}`}
                    stroke-dashoffset={-s.offset}
                    transform="rotate(-90 60 60)"
                  />
                ))}
              </svg>
              <div class="donut-center">
                <div class="donut-value">{money.fmtCompact(positiveTotal)}</div>
                <div class="muted">за месяц</div>
              </div>
            </div>
          )}

          <div class="card">
            {rows.map(([id, sum]) => {
              const c = categories.get(id);
              const share = sum > 0 && positiveTotal > 0 ? Math.round((sum / positiveTotal) * 100) : null;
              const delta = percentChange(sum, prevSums.get(id) ?? 0);
              return (
                <button class="row report-row" key={id} onClick={() => onOpenCategory(id, ym)}>
                  <span class="swatch-dot" style={{ background: sliceColor.get(id) ?? OTHER_COLOR }} aria-hidden="true" />
                  <span class="row-main">
                    <span class="row-title">
                      {c?.emoji} {c?.name ?? 'Без категории'}
                    </span>
                    <span class="row-sub">
                      {share !== null ? `${share}%` : 'возврат'}
                      {delta !== null && delta !== 0 && (
                        <>
                          {' · '}
                          {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}% {cmp.partial ? 'к тем же дням' : 'к прошлому месяцу'}
                        </>
                      )}
                    </span>
                  </span>
                  <span class="row-amount num">{money.fmt(sum)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <section class="group">
        <h3 class="group-head">
          <span>По месяцам</span>
          <span class="segmented" role="group" aria-label="Период">
            {([6, 12] as Span[]).map((n) => (
              <button key={n} class={span === n ? 'is-on' : ''} aria-pressed={span === n} onClick={() => changeSpan(n)}>
                {n} мес
              </button>
            ))}
          </span>
        </h3>
        <div class="card columns-card">
          <div class={`columns span-${span}`}>
            {months.map((m, i) => (
              <button
                key={m}
                class={`col ${m === ym ? 'is-on' : ''}`}
                onClick={() => setYm(m)}
                aria-pressed={m === ym}
                aria-label={`${formatMonth(m)}: ${money.fmt(values[i])}`}
              >
                <span class="col-plot">
                  {m === ym && <span class="col-value">{money.fmtCompact(values[i])}</span>}
                  <span class="col-bar" style={{ height: `${(values[i] / maxValue) * 100}%` }} />
                </span>
                <span class="col-label">{monthShort(m)}</span>
              </button>
            ))}
          </div>
          {average !== null && <div class="row-sub columns-note">В среднем {money.fmt(average)} в месяц</div>}
        </div>
        <details class="table-view">
          <summary>Показать таблицей</summary>
          <div class="card">
            {[...months].reverse().map((m) => (
              <div class="row" key={m}>
                <span class="row-main row-title">{formatMonth(m, currentYm)}</span>
                <span class="row-amount num">{money.fmt(Math.max(0, totals.get(m) ?? 0))}</span>
              </div>
            ))}
          </div>
        </details>
      </section>
    </div>
  );
}
