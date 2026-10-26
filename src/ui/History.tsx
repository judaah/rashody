import { useState } from 'preact/hooks';
import type { Category, Expense } from '../db/db';
import { expensesOfMonth, searchExpenses } from '../db/repo';
import { formatMoney } from '../lib/money';
import { formatMonth, monthOf, shiftMonth } from '../lib/dates';
import { useLive, useToday } from '../lib/hooks';
import { DayGroups, EmptyState } from './common';
import { IconBack, IconChevron, IconSearch } from './icons';

export function History({
  categories,
  categoryList,
  initialCategory,
  initialMonth,
  onOpen,
}: {
  categories: Map<string, Category>;
  categoryList: Category[];
  initialCategory: string | null;
  initialMonth: string | null;
  onOpen: (e: Expense) => void;
}) {
  const today = useToday();
  const currentYm = monthOf(today);
  const [ym, setYm] = useState(initialMonth ?? currentYm);
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(initialCategory);

  const searching = query.trim() !== '';
  const items = useLive(
    () => (searching ? searchExpenses(query, categoryList) : expensesOfMonth(ym)),
    [searching ? query : '', ym, categoryList],
  );
  const shown = (items ?? []).filter((e) => !categoryId || e.categoryId === categoryId);
  const total = shown.reduce((s, e) => s + e.amountRub, 0);

  return (
    <div class="screen-body">
      <header class="screen-head">
        {searching ? (
          <div class="month-switch">
            <span class="month-title">Найдено: {shown.length}</span>
          </div>
        ) : (
          <div class="month-switch">
            <button class="icon-btn" onClick={() => setYm(shiftMonth(ym, -1))} aria-label="Предыдущий месяц">
              <IconBack />
            </button>
            <span class="month-title">{formatMonth(ym, currentYm)}</span>
            <button
              class="icon-btn"
              onClick={() => setYm(shiftMonth(ym, 1))}
              disabled={ym >= currentYm}
              aria-label="Следующий месяц"
            >
              <IconChevron />
            </button>
          </div>
        )}
        <div class="month-total" data-testid="history-total">
          {formatMoney(total)}
        </div>
      </header>

      <label class="search">
        <IconSearch size={18} />
        <input
          type="search"
          placeholder="Поиск по заметкам и категориям"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </label>

      <div class="chips-scroll">
        <button class={`chip ${categoryId === null ? 'is-on' : ''}`} onClick={() => setCategoryId(null)}>
          Все
        </button>
        {categoryList
          .filter((c) => !c.archived || c.id === categoryId)
          .map((c) => (
            <button
              key={c.id}
              class={`chip ${categoryId === c.id ? 'is-on' : ''}`}
              onClick={() => setCategoryId(categoryId === c.id ? null : c.id)}
            >
              {c.emoji} {c.name}
            </button>
          ))}
      </div>

      {items && shown.length === 0 ? (
        <EmptyState
          title={searching ? 'Ничего не нашлось' : 'Трат нет'}
          text={searching ? 'Попробуй другое слово.' : 'За этот месяц ничего не записано.'}
        />
      ) : (
        <DayGroups expenses={shown} categories={categories} today={today} onOpen={onOpen} />
      )}
    </div>
  );
}
