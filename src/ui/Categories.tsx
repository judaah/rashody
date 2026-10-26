import { useState } from 'preact/hooks';
import type { Category } from '../db/db';
import { addCategory, moveCategory, updateCategory } from '../db/repo';
import { CATEGORY_COLORS } from '../db/seed';
import { CategoryBadge } from './common';
import { showToast } from './toast';
import { IconBack, IconDown, IconUp } from './icons';

/** Символы строки, как их видит человек (эмодзи с модификаторами — один символ). */
function graphemes(s: string): string[] {
  const trimmed = s.trim();
  if ('Segmenter' in Intl) {
    return Array.from(new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(trimmed), (x) => x.segment);
  }
  return Array.from(trimmed);
}

const firstGrapheme = (s: string) => graphemes(s)[0] ?? '';
// В поле эмодзи оставляем последний введённый символ — так новый заменяет старый.
const lastGrapheme = (s: string) => graphemes(s).at(-1) ?? '';

type FormState = { mode: 'new' } | { mode: 'edit'; category: Category };

export function Categories({ categories, onBack }: { categories: Category[]; onBack: () => void }) {
  const [form, setForm] = useState<FormState | null>(null);
  const active = categories.filter((c) => !c.archived);
  const archived = categories.filter((c) => c.archived);

  return (
    <div class="screen-body">
      <header class="nav-head">
        <button class="link nav-back" onClick={onBack}>
          <IconBack size={20} /> Настройки
        </button>
        <h1 class="nav-title">Категории</h1>
      </header>

      <div class="card">
        {active.map((c, i) => (
          <div class="row" key={c.id}>
            <button class="row-tap" onClick={() => setForm({ mode: 'edit', category: c })}>
              <CategoryBadge category={c} size={32} />
              <span class="row-title">{c.name}</span>
            </button>
            <button class="icon-btn" disabled={i === 0} onClick={() => moveCategory(c.id, -1)} aria-label={`Поднять ${c.name}`}>
              <IconUp size={20} />
            </button>
            <button
              class="icon-btn"
              disabled={i === active.length - 1}
              onClick={() => moveCategory(c.id, 1)}
              aria-label={`Опустить ${c.name}`}
            >
              <IconDown size={20} />
            </button>
          </div>
        ))}
      </div>
      <button class="btn btn-plain" onClick={() => setForm({ mode: 'new' })}>
        + Новая категория
      </button>

      {archived.length > 0 && (
        <section class="group">
          <h3 class="group-head">
            <span>В архиве</span>
          </h3>
          <p class="footnote">Старые траты в них сохраняются, но при вводе этих категорий нет.</p>
          <div class="card">
            {archived.map((c) => (
              <div class="row" key={c.id}>
                <CategoryBadge category={c} size={32} />
                <span class="row-main row-title">{c.name}</span>
                <button
                  class="link"
                  onClick={async () => {
                    const maxOrder = Math.max(-1, ...active.map((a) => a.order));
                    await updateCategory(c.id, { archived: false, order: maxOrder + 1 });
                  }}
                >
                  Вернуть
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {form && <CategoryForm state={form} activeCount={active.length} onClose={() => setForm(null)} />}
    </div>
  );
}

function CategoryForm({ state, activeCount, onClose }: { state: FormState; activeCount: number; onClose: () => void }) {
  const initial = state.mode === 'edit' ? state.category : null;
  const [name, setName] = useState(initial?.name ?? '');
  const [emoji, setEmoji] = useState(initial?.emoji ?? '');
  const [color, setColor] = useState(initial?.color ?? CATEGORY_COLORS[0]);

  const save = async () => {
    const cleanName = name.trim();
    const cleanEmoji = firstGrapheme(emoji) || '🏷️';
    if (!cleanName) return showToast('Введи название');
    if (initial) {
      await updateCategory(initial.id, { name: cleanName, emoji: cleanEmoji, color });
    } else {
      await addCategory({ name: cleanName, emoji: cleanEmoji, color });
    }
    onClose();
  };

  const archive = async () => {
    if (!initial) return;
    if (activeCount <= 1) return showToast('Должна остаться хотя бы одна категория');
    await updateCategory(initial.id, { archived: true });
    onClose();
    showToast(`«${initial.name}» в архиве`, {
      action: 'Вернуть',
      onAction: () => void updateCategory(initial.id, { archived: false }),
    });
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label={initial ? 'Категория' : 'Новая категория'}>
      <header class="sheet-head">
        <button class="link" onClick={onClose}>
          Отмена
        </button>
        <span class="sheet-title">{initial ? 'Категория' : 'Новая категория'}</span>
        <button class="link strong" onClick={save}>
          Готово
        </button>
      </header>
      <div class="form">
        <div class="form-preview">
          <CategoryBadge category={{ id: '', name, emoji: firstGrapheme(emoji) || '🏷️', color, order: 0, archived: false }} size={64} />
        </div>
        <label class="field">
          <span>Название</span>
          <input type="text" value={name} maxLength={30} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label class="field">
          <span>Эмодзи</span>
          <input
            type="text"
            value={emoji}
            placeholder="Переключи клавиатуру на эмодзи"
            onInput={(e) => {
              const input = e.target as HTMLInputElement;
              const next = lastGrapheme(input.value);
              input.value = next;
              setEmoji(next);
            }}
          />
        </label>
        <div class="field">
          <span>Цвет</span>
          <div class="swatches">
            {CATEGORY_COLORS.map((c) => (
              <button
                key={c}
                class={`swatch ${c === color ? 'is-on' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`Цвет ${c}`}
              />
            ))}
          </div>
        </div>
        {initial && (
          <button class="btn btn-danger-plain" onClick={archive}>
            Убрать в архив
          </button>
        )}
      </div>
    </div>
  );
}
