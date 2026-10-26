import type { Category, Expense } from '../db/db';
import type { Scope } from '../db/scope';
import { formatMoney } from '../lib/money';
import { formatDay } from '../lib/dates';
import { useToday } from '../lib/hooks';
import { CategoryBadge } from './common';
import { useMoney } from './displayMoney';

/** Первая буква имени для значка на тратах партнёра. */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : 'П';
}

export function ScopeSwitch({ scope, onChange, partnerName }: { scope: Scope; onChange: (s: Scope) => void; partnerName: string }) {
  const items: Array<[Scope, string]> = [
    ['me', 'Я'],
    ['partner', partnerName],
    ['together', 'Вместе'],
  ];
  return (
    <div class="scope-switch" role="group" aria-label="Чьи траты показывать">
      {items.map(([value, label]) => (
        <button key={value} class={scope === value ? 'is-on' : ''} aria-pressed={scope === value} onClick={() => onChange(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Трата партнёра: только посмотреть, правит её он сам на своём телефоне. */
export function PartnerExpenseView({
  expense,
  category,
  partnerName,
  onClose,
}: {
  expense: Expense;
  category?: Category;
  partnerName: string;
  onClose: () => void;
}) {
  const today = useToday();
  const money = useMoney();
  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label={`Трата: ${partnerName}`}>
      <header class="sheet-head">
        <span class="link-placeholder" />
        <span class="sheet-title">Трата · {partnerName}</span>
        <button class="link strong" onClick={onClose}>
          Готово
        </button>
      </header>
      <div class="form partner-view">
        <div class="form-preview">
          <CategoryBadge category={category} size={64} />
          <div class={`partner-view-amount ${expense.amountRub < 0 ? 'is-refund' : ''}`}>{formatMoney(expense.amount, expense.currency)}</div>
          {expense.currency !== money.code && <div class="row-sub">{money.fmt(expense.amountRub)}</div>}
        </div>
        <div class="card">
          <div class="row">
            <span class="row-main row-title">Категория</span>
            <span class="row-value">{category ? `${category.emoji} ${category.name}` : 'Без категории'}</span>
          </div>
          <div class="row">
            <span class="row-main row-title">Дата</span>
            <span class="row-value">{formatDay(expense.date, today)}</span>
          </div>
          {expense.note && (
            <div class="row">
              <span class="row-main row-title">Заметка</span>
              <span class="row-value partner-view-note">{expense.note}</span>
            </div>
          )}
        </div>
        <p class="footnote center">Записано на телефоне партнёра ({partnerName}). Изменить или удалить трату можно только там.</p>
      </div>
    </div>
  );
}
