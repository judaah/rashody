import { useState } from 'preact/hooks';
import type { Category } from '../db/db';
import { allBudgets, expensesOfMonth, setBudget } from '../db/repo';
import { evalAmount, formatMoney, minorToInput } from '../lib/money';
import { formatMonth, monthOf } from '../lib/dates';
import { activeBudgets, budgetState, budgetTotal, sumByCategory, type BudgetState } from '../lib/stats';
import { useLive, useToday } from '../lib/hooks';
import { CategoryBadge } from './common';
import { IconBack, IconChevron } from './icons';

const LEVEL_TEXT = { ok: 'в пределах', warn: 'почти исчерпан', over: 'перерасход' } as const;

/** Полоска бюджета: цвет заливки — состояние, дорожка — светлый тон того же цвета. */
export function BudgetMeter({ state }: { state: BudgetState }) {
  return (
    <span
      class={`meter level-${state.level}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={state.limit}
      aria-valuenow={state.spent}
      aria-label={LEVEL_TEXT[state.level]}
    >
      <span style={{ width: `${Math.min(state.ratio, 1) * 100}%` }} />
    </span>
  );
}

/** «осталось 3 200 ₽» / «перерасход 1 200 ₽» — текст рядом с полоской, чтобы смысл не держался на цвете. */
export function budgetCaption(state: BudgetState, withLimit = true): string {
  if (state.left < 0) return `перерасход ${formatMoney(-state.left)}`;
  return withLimit ? `осталось ${formatMoney(state.left)} из ${formatMoney(state.limit)}` : `осталось ${formatMoney(state.left)}`;
}

export function Budgets({ categoryList, categories, onBack }: { categoryList: Category[]; categories: Map<string, Category>; onBack: () => void }) {
  const today = useToday();
  const ym = monthOf(today);
  const [editing, setEditing] = useState<Category | null>(null);
  const data = useLive(async () => ({ budgets: await allBudgets(), month: await expensesOfMonth(ym) }), [ym]);
  if (!data) return null;

  const sums = sumByCategory(data.month);
  const limits = new Map(data.budgets.map((b) => [b.categoryId, b.limit]));
  const total = budgetTotal(activeBudgets(data.budgets, categories), sums);
  const active = categoryList.filter((c) => !c.archived);

  return (
    <div class="screen-body">
      <header class="nav-head">
        <button class="link nav-back" onClick={onBack}>
          <IconBack size={20} /> Настройки
        </button>
        <h1 class="nav-title">Бюджеты</h1>
      </header>
      <p class="footnote lead">Месячный лимит на категорию. На 80% полоска желтеет, при перерасходе краснеет.</p>

      {total && (
        <div class="card budget-card">
          <div class="budget-line">
            <span>Все лимиты на {formatMonth(ym, ym).toLowerCase()}</span>
            <b>{formatMoney(total.limit)}</b>
          </div>
          <BudgetMeter state={total} />
          <div class="row-sub">Потрачено {formatMoney(total.spent)} · {budgetCaption(total)}</div>
        </div>
      )}

      <div class="card">
        {active.map((c) => {
          const limit = limits.get(c.id);
          const spent = Math.max(0, sums.get(c.id) ?? 0);
          const state = limit ? budgetState(spent, limit) : null;
          return (
            <button class="row cat-row" key={c.id} onClick={() => setEditing(c)}>
              <CategoryBadge category={c} size={32} />
              <span class="row-main">
                <span class="row-title">{c.name}</span>
                {state ? (
                  <>
                    <BudgetMeter state={state} />
                    <span class="row-sub">{budgetCaption(state, false)}</span>
                  </>
                ) : (
                  <span class="row-sub">в этом месяце {formatMoney(spent)}</span>
                )}
              </span>
              <span class="row-value">{limit ? formatMoney(limit) : 'без лимита'}</span>
              <IconChevron size={18} />
            </button>
          );
        })}
      </div>

      {editing && (
        <BudgetForm
          category={editing}
          current={limits.get(editing.id) ?? null}
          spent={Math.max(0, sums.get(editing.id) ?? 0)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function BudgetForm({ category, current, spent, onClose }: { category: Category; current: number | null; spent: number; onClose: () => void }) {
  const [text, setText] = useState(current ? minorToInput(current) : '');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = text.replace(/\s/g, '');
    if (trimmed === '') {
      await setBudget(category.id, null);
      return onClose();
    }
    const limit = evalAmount(trimmed);
    if (limit === null || limit <= 0) return setError('Введи сумму больше нуля или оставь поле пустым');
    await setBudget(category.id, limit);
    onClose();
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label={`Бюджет: ${category.name}`}>
      <header class="sheet-head">
        <button class="link" onClick={onClose}>
          Отмена
        </button>
        <span class="sheet-title">Бюджет</span>
        <button class="link strong" onClick={save}>
          Готово
        </button>
      </header>
      <div class="form">
        <div class="form-preview">
          <CategoryBadge category={category} size={64} />
          <div class="form-preview-title">{category.name}</div>
          <div class="row-sub">в этом месяце потрачено {formatMoney(spent)}</div>
        </div>
        <label class="field">
          <span>Лимит в месяц, ₽</span>
          <input
            type="text"
            inputMode="decimal"
            value={text}
            placeholder="Без лимита"
            onInput={(e) => {
              setError(null);
              setText((e.target as HTMLInputElement).value);
            }}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
        </label>
        {error && (
          <div class="hint is-error" role="alert">
            {error}
          </div>
        )}
        {current && (
          <button
            class="btn btn-danger-plain"
            onClick={async () => {
              await setBudget(category.id, null);
              onClose();
            }}
          >
            Убрать лимит
          </button>
        )}
      </div>
    </div>
  );
}
