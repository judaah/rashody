import type { Category, Expense } from '../db/db';
import { formatMoney } from '../lib/money';
import { formatDay } from '../lib/dates';

/** size не задан — размер берётся из CSS (так сетка ввода ужимается на маленьких экранах). */
export function CategoryBadge({ category, size }: { category?: Category; size?: number }) {
  const dims = size ? { width: size, height: size, fontSize: size * 0.5 } : {};
  return (
    <span class="cat-badge" style={{ ...dims, '--cat': category?.color ?? '#8e8e93' }} aria-hidden="true">
      {category?.emoji ?? '❔'}
    </span>
  );
}

export function ExpenseRow({ expense, category, onClick }: { expense: Expense; category?: Category; onClick: () => void }) {
  return (
    <button class="row expense-row" onClick={onClick}>
      <CategoryBadge category={category} size={40} />
      <span class="row-main">
        <span class="row-title">{category?.name ?? 'Без категории'}</span>
        {expense.note && <span class="row-sub">{expense.note}</span>}
      </span>
      <span class={`row-amount ${expense.amountRub < 0 ? 'is-refund' : ''}`}>
        {formatMoney(expense.amount, expense.currency)}
        {expense.currency !== 'RUB' && <span class="row-sub">{formatMoney(expense.amountRub)}</span>}
      </span>
    </button>
  );
}

/** Список трат, сгруппированный по дням, с итогом за день. Ожидает траты от новых к старым. */
export function DayGroups({
  expenses,
  categories,
  today,
  onOpen,
}: {
  expenses: Expense[];
  categories: Map<string, Category>;
  today: string;
  onOpen: (e: Expense) => void;
}) {
  const groups: Array<{ date: string; items: Expense[]; total: number }> = [];
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
            <span class="num">{formatMoney(g.total)}</span>
          </h3>
          <div class="card">
            {g.items.map((e) => (
              <ExpenseRow key={e.id} expense={e} category={categories.get(e.categoryId)} onClick={() => onOpen(e)} />
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
