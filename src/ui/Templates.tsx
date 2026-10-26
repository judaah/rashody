import { useState } from 'preact/hooks';
import type { Category, Template } from '../db/db';
import { addExpenseFromTemplate, allTemplates, deleteExpense, deleteTemplate, expensesBetween, moveTemplate, saveTemplate } from '../db/repo';
import { evalAmount, formatMoney, minorToInput } from '../lib/money';
import { addDays } from '../lib/dates';
import { frequentPairs, type Suggestion } from '../lib/stats';
import { useLive, useToday } from '../lib/hooks';
import { CategoryBadge } from './common';
import { showToast } from './toast';
import { IconBack, IconDown, IconUp } from './icons';

const SUGGEST_WINDOW_DAYS = 90;

/** Шаблоны и подсказки для главной: шаблоны с архивными категориями прячем. */
export function useQuickEntries(categories: Map<string, Category>) {
  const today = useToday();
  return useLive(async () => {
    const templates = await allTemplates();
    const recent = await expensesBetween(addDays(today, -SUGGEST_WINDOW_DAYS), addDays(today, 1));
    return {
      templates: templates.filter((t) => categories.get(t.categoryId) && !categories.get(t.categoryId)!.archived),
      suggestions: frequentPairs(recent, templates, categories),
    };
  }, [today, categories]);
}

export async function recordTemplate(template: Template, category: Category, date: string) {
  const created = await addExpenseFromTemplate(template, category, date);
  const label = created.note ? `${created.note} · ${category.name}` : category.name;
  showToast(`${formatMoney(template.amount)} · ${label}`, {
    action: 'Отменить',
    onAction: () => void deleteExpense(created.id),
  });
}

export function suggestionAsTemplate(s: Suggestion, category: Category): Template {
  return { id: '', name: category.name, amount: s.amount, currency: 'RUB', categoryId: s.categoryId, order: 0 };
}

// ---------- экран «Шаблоны» в настройках ----------

type FormState = { mode: 'new'; preset?: Pick<Template, 'amount' | 'categoryId' | 'name'> } | { mode: 'edit'; template: Template };

export function Templates({ categories, categoryList, onBack }: { categories: Map<string, Category>; categoryList: Category[]; onBack: () => void }) {
  const [form, setForm] = useState<FormState | null>(null);
  const templates = useLive(() => allTemplates(), []);
  const quick = useQuickEntries(categories);
  if (!templates) return null;

  return (
    <div class="screen-body">
      <header class="nav-head">
        <button class="link nav-back" onClick={onBack}>
          <IconBack size={20} /> Настройки
        </button>
        <h1 class="nav-title">Шаблоны</h1>
      </header>
      <p class="footnote lead">Кнопки на главной: одно нажатие — и трата записана на сегодня.</p>

      {templates.length > 0 && (
        <div class="card">
          {templates.map((t, i) => {
            const c = categories.get(t.categoryId);
            return (
              <div class="row" key={t.id}>
                <button class="row-tap" onClick={() => setForm({ mode: 'edit', template: t })}>
                  <CategoryBadge category={c} size={32} />
                  <span class="row-main">
                    <span class="row-title">{t.name}</span>
                    <span class="row-sub">
                      {c?.name ?? 'Без категории'}
                      {c?.archived ? ' · категория в архиве' : ''}
                    </span>
                  </span>
                  <span class="row-amount num">{formatMoney(t.amount)}</span>
                </button>
                <button class="icon-btn" disabled={i === 0} onClick={() => moveTemplate(t.id, -1)} aria-label={`Поднять ${t.name}`}>
                  <IconUp size={20} />
                </button>
                <button
                  class="icon-btn"
                  disabled={i === templates.length - 1}
                  onClick={() => moveTemplate(t.id, 1)}
                  aria-label={`Опустить ${t.name}`}
                >
                  <IconDown size={20} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <button class="btn btn-plain" onClick={() => setForm({ mode: 'new' })}>
        + Новый шаблон
      </button>

      {quick && quick.suggestions.length > 0 && (
        <section class="group">
          <h3 class="group-head">
            <span>Часто повторяются</span>
          </h3>
          <div class="card">
            {quick.suggestions.map((s) => {
              const c = categories.get(s.categoryId)!;
              return (
                <div class="row" key={`${s.categoryId}|${s.amount}`}>
                  <CategoryBadge category={c} size={32} />
                  <span class="row-main">
                    <span class="row-title">
                      {c.name} · <span class="num">{formatMoney(s.amount)}</span>
                    </span>
                    <span class="row-sub">записано {s.count} раз за 3 месяца</span>
                  </span>
                  <button
                    class="link strong"
                    onClick={() => setForm({ mode: 'new', preset: { amount: s.amount, categoryId: s.categoryId, name: c.name } })}
                  >
                    Добавить
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {form && <TemplateForm state={form} categoryList={categoryList} onClose={() => setForm(null)} />}
    </div>
  );
}

export function TemplateForm({ state, categoryList, onClose }: { state: FormState; categoryList: Category[]; onClose: () => void }) {
  const initial = state.mode === 'edit' ? state.template : (state.preset ?? null);
  const [name, setName] = useState(initial?.name ?? '');
  const [amountText, setAmountText] = useState(initial ? minorToInput(initial.amount) : '');
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? '');
  const [error, setError] = useState<string | null>(null);
  const editingId = state.mode === 'edit' ? state.template.id : undefined;
  const visible = categoryList.filter((c) => !c.archived || c.id === categoryId);

  const save = async () => {
    const amount = evalAmount(amountText.replace(/\s/g, ''));
    const category = categoryList.find((c) => c.id === categoryId);
    if (amount === null || amount <= 0) return setError('Введи сумму больше нуля');
    if (!category) return setError('Выбери категорию');
    await saveTemplate({ id: editingId, name: name.trim() || category.name, amount, categoryId });
    onClose();
  };

  const remove = async () => {
    if (!editingId) return;
    await deleteTemplate(editingId);
    onClose();
    showToast('Шаблон удалён');
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label={editingId ? 'Шаблон' : 'Новый шаблон'}>
      <header class="sheet-head">
        <button class="link" onClick={onClose}>
          Отмена
        </button>
        <span class="sheet-title">{editingId ? 'Шаблон' : 'Новый шаблон'}</span>
        <button class="link strong" onClick={save}>
          Готово
        </button>
      </header>
      <div class="form">
        <label class="field">
          <span>Название</span>
          <input
            type="text"
            value={name}
            maxLength={24}
            placeholder="Например, Кофе"
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>Сумма, ₽</span>
          <input
            type="text"
            inputMode="decimal"
            value={amountText}
            placeholder="0"
            onInput={(e) => {
              setError(null);
              setAmountText((e.target as HTMLInputElement).value);
            }}
          />
        </label>
        <div class="field">
          <span>Категория</span>
          <div class="cat-grid cat-grid-static">
            {visible.map((c) => (
              <button
                key={c.id}
                class={`cat-cell ${c.id === categoryId ? 'is-on' : ''}`}
                onClick={() => {
                  setError(null);
                  setCategoryId(c.id);
                }}
              >
                <CategoryBadge category={c} />
                <span class="cat-name">{c.name}</span>
              </button>
            ))}
          </div>
        </div>
        {error && (
          <div class="hint is-error" role="alert">
            {error}
          </div>
        )}
        {editingId && (
          <button class="btn btn-danger-plain" onClick={remove}>
            Удалить шаблон
          </button>
        )}
      </div>
    </div>
  );
}
