import type { Category, Expense } from '../db/db';
import { formatMoney } from '../lib/money';
import { formatDay } from '../lib/dates';
import { useMoney } from './displayMoney';

/** size не задан — размер берётся из CSS (так сетка ввода ужимается на маленьких экранах). */
export function CategoryBadge({ category, size }: { category?: Category; size?: number }) {
  const dims = size ? { width: size, height: size, fontSize: size * 0.5 } : {};
  return (
    <span class="cat-badge" style={{ ...dims, '--cat': category?.color ?? '#8e8e93' }} aria-hidden="true">
      {category?.emoji ?? '❔'}
    </span>
  );
}

/** У трат партнёра в режиме «Вместе» — его инициал на значке категории. */
export function ExpenseRow({
  expense,
  category,
  onClick,
  ownerMark,
}: {
  expense: Expense;
  category?: Category;
  onClick: () => void;
  ownerMark?: string;
}) {
  const money = useMoney();
  return (
    <button class="row expense-row" onClick={onClick}>
      <span class="badge-wrap">
        <CategoryBadge category={category} size={40} />
        {ownerMark && (
          <span class="owner-mark" aria-label={`трата партнёра`}>
            {ownerMark}
          </span>
        )}
      </span>
      <span class="row-main">
        <span class="row-title">{category?.name ?? 'Без категории'}</span>
        {expense.note && <span class="row-sub">{expense.note}</span>}
      </span>
      <span class={`row-amount ${expense.amountRub < 0 ? 'is-refund' : ''}`}>
        {formatMoney(expense.amount, expense.currency)}
        {expense.currency !== money.code && <span class="row-sub">{money.fmt(expense.amountRub)}</span>}
      </span>
    </button>
  );
}

/** Список трат, сгруппированный по дням, с итогом за день. Ожидает траты от новых к старым. */
export function DayGroups<T extends Expense & { owner?: 'me' | 'partner' }>({
  expenses,
  categories,
  today,
  onOpen,
  partnerMark,
}: {
  expenses: T[];
  categories: Map<string, Category>;
  today: string;
  onOpen: (e: T) => void;
  /** Инициал партнёра — показывается на его тратах; не задан — не показывается. */
  partnerMark?: string;
}) {
  const money = useMoney();
  const groups: Array<{ date: string; items: T[]; total: number }> = [];
  for (const e of expenses) {
    let g = groups[groups.length - 1];
    if (!g || g.date !== e.date) {
      g = { date: e.date, items: [], total: 0 };
      groups.push(g);
    }
    g.items.push(e);
    g.total += e.amountRub;
  }
  return (
    <>
      {groups.map((g) => (
        <section class="group" key={g.date}>
          <h3 class="group-head">
            <span>{formatDay(g.date, today)}</span>
            <span class="num">{money.fmt(g.total)}</span>
          </h3>
          <div class="card">
            {g.items.map((e) => (
              <ExpenseRow
                key={`${e.owner ?? 'me'}:${e.id}`}
                expense={e}
                category={categories.get(e.categoryId)}
                onClick={() => onOpen(e)}
                ownerMark={e.owner === 'partner' ? partnerMark : undefined}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div class="empty">
      <div class="empty-title">{title}</div>
      <div class="empty-text">{text}</div>
    </div>
  );
}
