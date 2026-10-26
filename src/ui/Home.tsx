import { useState } from 'preact/hooks';
import type { Category, Expense } from '../db/db';
import { db } from '../db/db';
import { allBudgets, getSetting, SETTING_LAST_BACKUP } from '../db/repo';
import { scopedFirstDate, scopedMonth, scopedRecent, type OwnedExpense, type Scope } from '../db/scope';
import { formatMoney } from '../lib/money';
import { daysBetween, formatMonth, monthOf, monthRange } from '../lib/dates';
import { useLive, useToday } from '../lib/hooks';
import { needsBackupReminder } from '../lib/backup';
import { activeBudgets, budgetState, budgetTotal, dailyAllowance, sumByCategory } from '../lib/stats';
import { CategoryBadge, DayGroups, EmptyState } from './common';
import { BudgetMeter, budgetCaption } from './Budgets';
import { recordTemplate, suggestionAsTemplate, TemplateForm, useQuickEntries } from './Templates';
import { saveBackupFile } from './files';
import { IconQr } from './icons';
import { useMoney } from './displayMoney';

const RECENT_LIMIT = 15;

export function Home({
  categories,
  categoryList,
  onOpen,
  onOpenCategory,
  onShowHistory,
  onScanReceipt,
  scope,
  partnerName,
  partnerMark,
}: {
  categories: Map<string, Category>;
  categoryList: Category[];
  onOpen: (e: Expense | OwnedExpense) => void;
  onOpenCategory: (categoryId: string) => void;
  onShowHistory: () => void;
  onScanReceipt: () => void;
  scope: Scope;
  partnerName: string;
  partnerMark: string;
}) {
  const money = useMoney();
  const today = useToday();
  const ym = monthOf(today);
  const [templateForm, setTemplateForm] = useState(false);
  const month = useLive(() => scopedMonth(ym, scope), [ym, scope]);
  const recent = useLive(() => scopedRecent(RECENT_LIMIT, scope), [scope]);
  // Шаблоны, бюджет и быстрая запись — про мои траты, в других режимах их не показываем.
  const mine = scope === 'me';
  const quick = useQuickEntries(categories);
  const meta = useLive(async () => {
    const firstCreated = await db.expenses.orderBy('createdAt').first();
    const lastBackup = await getSetting<number | null>(SETTING_LAST_BACKUP, null);
    return {
      backupDue: needsBackupReminder(lastBackup, firstCreated?.createdAt ?? null),
      firstDate: await scopedFirstDate(scope),
      budgets: mine ? await allBudgets() : [],
    };
  }, [scope]);

  if (!month || !recent || !meta) return null;

  const total = month.reduce((s, e) => s + e.amountRub, 0);
  const todayTotal = month.filter((e) => e.date === today).reduce((s, e) => s + e.amountRub, 0);
  // Среднее считаем с первой записанной траты, а не с 1-го числа — иначе в первый
  // месяц пользования оно занижено. Пока данных меньше чем за 2 дня — не показываем.
  const [monthStart] = monthRange(ym);
  const countFrom = meta.firstDate && meta.firstDate > monthStart ? meta.firstDate : monthStart;
  const trackedDays = daysBetween(countFrom, today) + 1;
  const perDay = trackedDays >= 2 ? Math.round(total / trackedDays / 100) * 100 : null; // до рубля

  const sums = sumByCategory(month);
  const budgets = activeBudgets(meta.budgets, categories);
  const limits = new Map(budgets.map((b) => [b.categoryId, b.limit]));
  const budget = budgetTotal(budgets, sums);

  // В список попадают категории с тратами и категории с лимитом, даже если трат ещё нет.
  const ids = new Set([...[...sums.entries()].filter(([, v]) => v > 0).map(([id]) => id), ...limits.keys()]);
  const ranking = [...ids].map((id) => [id, Math.max(0, sums.get(id) ?? 0)] as const).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...ranking.filter(([id]) => !limits.has(id)).map(([, v]) => v));

  return (
    <div class="screen-body">
      <header class="hero">
        <div class="hero-month">
          {formatMonth(ym)}
          {scope === 'partner' ? ` · ${partnerName}` : scope === 'together' ? ' · вместе' : ''}
        </div>
        <div class="hero-total" data-testid="month-total">
          {money.fmt(total)}
        </div>
        <div class="hero-sub">
          Сегодня <b>{money.fmt(todayTotal)}</b>
          {total > 0 && perDay !== null && (
            <>
              {' · '}в среднем <b>{money.fmt(perDay)}</b> в день
            </>
          )}
        </div>
      </header>

      {quick && mine && (
        <div class="chips-scroll quick-row" aria-label="Быстрая запись">
          <button class="chip quick-chip chip-scan" onClick={onScanReceipt}>
            <IconQr size={16} /> Чек
          </button>
          {quick.templates.map((t) => {
            const c = categories.get(t.categoryId)!;
            return (
              <button key={t.id} class="chip quick-chip" onClick={() => void recordTemplate(t, c, today)}>
                <span aria-hidden="true">{c.emoji}</span> {t.name} <b class="num">{formatMoney(t.amount)}</b>
              </button>
            );
          })}
          {quick.suggestions.map((s) => {
            const c = categories.get(s.categoryId)!;
            return (
              <button
                key={`${s.categoryId}|${s.amount}`}
                class="chip quick-chip chip-suggest"
                aria-label={`Записать ${formatMoney(s.amount)} в «${c.name}» — часто повторяется`}
                onClick={() => void recordTemplate(suggestionAsTemplate(s, c), c, today)}
              >
                <span aria-hidden="true">{c.emoji}</span> <b class="num">{formatMoney(s.amount)}</b>
              </button>
            );
          })}
          <button class="chip quick-chip chip-add" onClick={() => setTemplateForm(true)}>
            + Шаблон
          </button>
        </div>
      )}

      {budget && (
        <div class="card budget-card">
          <div class="budget-line">
            <span>{budget.left >= 0 ? 'Осталось по бюджету' : 'Перерасход бюджета'}</span>
            <b class={budget.left < 0 ? 'danger' : ''}>{money.fmt(Math.abs(budget.left))}</b>
          </div>
          <BudgetMeter state={budget} />
          <div class="row-sub">
            Потрачено {money.fmt(budget.spent)} из {money.fmt(budget.limit)}
            {budget.left > 0 && <> · ≈ {money.fmt(dailyAllowance(budget.left, today))} в день до конца месяца</>}
          </div>
        </div>
      )}

      {meta.backupDue && (
        <div class="banner">
          <div>
            <b>Пора сохранить бэкап.</b> Данные хранятся только на телефоне: если удалить иконку приложения, они пропадут.
          </div>
          <button class="btn btn-small" onClick={() => void saveBackupFile()}>
            Сохранить
          </button>
        </div>
      )}

      {recent.length === 0 && ranking.length === 0 ? (
        <EmptyState
          title="Пока пусто"
          text={
            scope === 'partner'
              ? `${partnerName}: трат пока нет. Они появятся здесь, когда партнёр их запишет.`
              : 'Нажми «+», введи сумму и выбери категорию — первая трата сохранится.'
          }
        />
      ) : (
        <>
          {ranking.length > 0 && (
            <section class="group">
              <h3 class="group-head">
                <span>По категориям</span>
              </h3>
              <div class="card">
                {ranking.map(([id, sum]) => {
                  const c = categories.get(id);
                  const limit = limits.get(id);
                  const state = limit ? budgetState(sum, limit) : null;
                  return (
                    <button class="row cat-row" key={id} onClick={() => onOpenCategory(id)}>
                      <CategoryBadge category={c} size={32} />
                      <span class="row-main">
                        <span class="row-title">{c?.name ?? 'Без категории'}</span>
                        {state ? (
                          <>
                            <BudgetMeter state={state} />
                            <span class="row-sub">{budgetCaption(state, money.fmt, false)}</span>
                          </>
                        ) : (
                          <span class="bar">
                            <span style={{ width: `${(sum / max) * 100}%` }} />
                          </span>
                        )}
                      </span>
                      <span class="row-amount num">{money.fmt(sum)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <DayGroups
            expenses={recent}
            categories={categories}
            today={today}
            onOpen={onOpen}
            partnerMark={scope === 'together' ? partnerMark : undefined}
          />
          {recent.length > 0 && (
            <button class="btn btn-plain" onClick={onShowHistory}>
              Вся история
            </button>
          )}
        </>
      )}

      {templateForm && <TemplateForm state={{ mode: 'new' }} categoryList={categoryList} onClose={() => setTemplateForm(false)} />}
    </div>
  );
}
