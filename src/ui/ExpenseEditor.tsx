import { useEffect, useRef, useState } from 'preact/hooks';
import type { Category, Expense } from '../db/db';
import { learnRules } from '../db/imports';
import { addExpense, deleteExpense, findByExternalId, lastCreatedExpense, restoreExpense, updateExpense } from '../db/repo';
import type { Receipt } from '../lib/receipt';
import { ReceiptScanner } from './ReceiptScanner';
import { resolveRate, type RateInfo } from '../db/rates';
import { applyKey, evalAmount, formatMoney, hasOperator, minorToInput, RUB, type KeypadKey } from '../lib/money';
import { displayNominal, formatRate, currencySymbol, toRub } from '../lib/rates';
import { addDays, formatShortDate, monthShort } from '../lib/dates';
import { useToday } from '../lib/hooks';
import { showToast } from './toast';
import { CategoryBadge } from './common';
import { CurrencyPicker } from './CurrencyPicker';
import { IconBackspace, IconCalendar, IconQr, IconTrash } from './icons';

/** scan — сразу открыть сканер чека (кнопка «Чек» на главной). */
export type EditorState = { mode: 'add'; scan?: boolean } | { mode: 'edit'; expense: Expense };

const KEYS: KeypadKey[][] = [
  ['1', '2', '3', 'back'],
  ['4', '5', '6', '+'],
  ['7', '8', '9', '−'],
  [',', '0', '000', 'clear'],
];

const KEY_FROM_KEYBOARD: Record<string, KeypadKey> = {
  ',': ',',
  '.': ',',
  '+': '+',
  '-': '−',
  Backspace: 'back',
  Delete: 'clear',
};

/** В поездке трат в одной валюте много подряд — новая трата берёт валюту прошлой, если та свежая. */
const KEEP_CURRENCY_MS = 12 * 60 * 60 * 1000;

/** key — для какой пары «валюта|дата» этот курс: чужой курс не показываем и не сохраняем. */
type RateState = { key: string; info: RateInfo | null; status: 'ready' | 'loading' | 'missing' };

const rateKey = (currency: string, date: string) => `${currency}|${date}`;
const rubRate = (date: string): RateState => ({ key: rateKey(RUB, date), info: { rate: 1, source: 'cbr', date }, status: 'ready' });

const shortDay = (iso: string) => `${Number(iso.slice(8, 10))} ${monthShort(iso.slice(0, 7))}`;

export function ExpenseEditor({
  state,
  categories,
  onClose,
}: {
  state: EditorState;
  categories: Category[];
  onClose: () => void;
}) {
  const editing = state.mode === 'edit' ? state.expense : null;
  const today = useToday();
  // Возврат (сумма с минусом) правим без знака: клавиатура не начинает выражение с минуса.
  const editingRefund = !!editing && editing.amount < 0;
  const [expr, setExpr] = useState(() => (editing ? minorToInput(Math.abs(editing.amount)) : ''));
  const [date, setDate] = useState(() => editing?.date ?? today);
  const [note, setNote] = useState(() => editing?.note ?? '');
  const [categoryId, setCategoryId] = useState(() => editing?.categoryId ?? '');
  const [currency, setCurrency] = useState(() => editing?.currency ?? RUB);
  // Курс, с которым трата уже сохранена, — к нему возвращаемся, если вернули её валюту и дату.
  const storedRate: RateState | null =
    editing && editing.currency !== RUB
      ? {
          key: rateKey(editing.currency, editing.date),
          info: { rate: editing.rate, source: editing.rateSource ?? 'manual', date: editing.date },
          status: 'ready',
        }
      : null;
  const [rate, setRate] = useState<RateState>(() => storedRate ?? rubRate(date));
  const [picker, setPicker] = useState(false);
  const [scanner, setScanner] = useState(state.mode === 'add' && !!state.scan);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [duplicate, setDuplicate] = useState<Expense | null>(null);
  const [shake, setShake] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  // Сохранение читает выражение отсюда, а не из замыкания: быстрые нажатия
  // «цифра → категория» могут прийти раньше, чем компонент перерисуется.
  const exprRef = useRef(expr);
  exprRef.current = expr;
  // Курс может ещё грузиться, когда человек уже нажал категорию — тогда ждём его.
  const ratePromise = useRef<Promise<RateState>>(Promise.resolve(rate));
  const currencyTouched = useRef(false);

  const amount = evalAmount(expr);
  const visibleCategories = categories.filter((c) => !c.archived || c.id === editing?.categoryId);
  const foreign = currency !== RUB;
  const currentKey = rateKey(currency, date);
  const keyRef = useRef(currentKey);
  keyRef.current = currentKey;
  // Пока эффект не подхватил новую валюту или дату, старый курс считаем «загружается».
  const shownRate: RateState = rate.key === currentKey ? rate : { key: currentKey, info: null, status: 'loading' };

  useEffect(() => {
    if (editing) return;
    void lastCreatedExpense().then((last) => {
      if (currencyTouched.current || !last || last.currency === RUB) return;
      if (Date.now() - last.createdAt < KEEP_CURRENCY_MS) setCurrency(last.currency);
    });
  }, []);

  useEffect(() => {
    // У открытой на правку траты курс уже есть — пока не меняли валюту и дату, не трогаем его.
    const unchanged = storedRate && currentKey === storedRate.key;
    if (currency === RUB || unchanged) {
      const fixed = currency === RUB ? rubRate(date) : storedRate!;
      setRate(fixed);
      ratePromise.current = Promise.resolve(fixed);
      return;
    }
    let cancelled = false;
    setRate({ key: currentKey, info: null, status: 'loading' });
    const pending = resolveRate(currency, date).then(
      (info): RateState => ({ key: rateKey(currency, date), info, status: info ? 'ready' : 'missing' }),
    );
    ratePromise.current = pending;
    void pending.then((next) => !cancelled && setRate(next));
    return () => {
      cancelled = true;
    };
  }, [currency, date]);

  const setManualRate = (perUnit: number) => {
    const next: RateState = { key: currentKey, info: { rate: perUnit, source: 'manual', date }, status: 'ready' };
    setRate(next);
    ratePromise.current = Promise.resolve(next);
    setError(null);
  };

  const press = (key: KeypadKey) => {
    setError(null);
    exprRef.current = applyKey(exprRef.current, key);
    setExpr(exprRef.current);
  };

  /** Чек отсканирован: сумма и дата с кассы, валюта — рубли; дальше человек выбирает категорию. */
  const applyReceipt = (r: Receipt) => {
    setScanner(false);
    setReceipt(r);
    setError(null);
    exprRef.current = minorToInput(r.amount);
    setExpr(exprRef.current);
    setDate(r.date);
    currencyTouched.current = true;
    setCurrency(RUB);
    setDuplicate(null);
    void findByExternalId(r.externalId).then((found) => setDuplicate(found ?? null));
  };

  const dropReceipt = () => {
    setReceipt(null);
    setDuplicate(null);
  };

  // Клавиатура компьютера — удобно при проверке и на iPad с клавиатурой.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement || picker || scanner) return;
      if (ev.key === 'Escape') return onClose();
      const key = /^\d$/.test(ev.key) ? (ev.key as KeypadKey) : KEY_FROM_KEYBOARD[ev.key];
      if (key) {
        ev.preventDefault();
        press(key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, picker, scanner]);

  // Ошибку показываем строкой в самом окне, а не тостом — тост закрыл бы шапку.
  const reject = (message: string) => {
    setShake(true);
    setTimeout(() => setShake(false), 400);
    setError(message);
  };
  const checkAmount = (value: number | null): value is number => {
    if (value !== null && value > 0) return true;
    reject(value !== null ? 'Сумма должна быть больше нуля' : 'Сначала введи сумму');
    return false;
  };

  /** Курс для сохранения; null — курса нет, человеку показана ошибка. */
  const rateForSave = async (): Promise<RateInfo | null> => {
    if (!foreign) return rubRate(date).info;
    let state = await ratePromise.current;
    // Нажали раньше, чем эффект начал грузить курс для новой валюты или даты, — грузим сами.
    if (state.key !== keyRef.current) state = { key: keyRef.current, info: await resolveRate(currency, date), status: 'ready' };
    if (!state.info) reject('Нет курса: введи его вручную');
    return state.info;
  };

  const saveNew = async (category: Category) => {
    if (busy.current) return;
    const value = evalAmount(exprRef.current);
    if (!checkAmount(value)) return;
    if (duplicate && !window.confirm(`Этот чек уже записан ${formatShortDate(duplicate.date)}. Записать ещё раз?`)) return;
    busy.current = true;
    try {
      const info = await rateForSave();
      if (!info) return;
      // Возврат по чеку — со знаком минус: он уменьшает траты категории.
      const signed = receipt?.refund ? -value : value;
      const created = await addExpense({
        amount: signed,
        categoryId: category.id,
        date,
        note,
        currency,
        rate: info.rate,
        rateSource: foreign ? info.source : undefined,
        ...(receipt ? { source: 'qr' as const, externalId: receipt.externalId } : {}),
      });
      onClose();
      const rub = foreign ? ` (${formatMoney(created.amountRub)})` : '';
      const kind = receipt ? (receipt.refund ? 'Возврат ' : 'Чек ') : '';
      showToast(`${kind}${formatMoney(signed, currency)}${rub} · ${category.name}`, {
        action: 'Отменить',
        onAction: () => void deleteExpense(created.id),
      });
    } finally {
      busy.current = false;
    }
  };

  const saveEdit = async () => {
    if (!editing || busy.current) return;
    const value = evalAmount(exprRef.current);
    if (!checkAmount(value)) return;
    busy.current = true;
    try {
      const info = await rateForSave();
      if (!info) return;
      await updateExpense(editing.id, {
        amount: editingRefund ? -value : value,
        categoryId,
        date,
        note,
        currency,
        rate: info.rate,
        rateSource: foreign ? info.source : undefined,
      });
      // Поправили категорию загруженной из выписки траты — запомним для этого магазина.
      if (editing.source === 'import' && categoryId !== editing.categoryId && editing.note) {
        void learnRules([{ description: editing.note, categoryId }]);
      }
      onClose();
      showToast('Сохранено');
    } finally {
      busy.current = false;
    }
  };

  const remove = async () => {
    if (!editing) return;
    const removed = await deleteExpense(editing.id);
    onClose();
    if (removed) showToast('Трата удалена', { action: 'Вернуть', onAction: () => void restoreExpense(removed) });
  };

  const negative = !!receipt?.refund || editingRefund;
  const yesterday = addDays(today, -1);
  const customDate = date !== today && date !== yesterday;
  const symbol = currencySymbol(currency);

  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label={editing ? 'Изменить трату' : 'Новая трата'}>
      <header class="sheet-head">
        <button class="link" onClick={onClose}>
          Отмена
        </button>
        <span class="sheet-title">{editing ? 'Изменить' : 'Новая трата'}</span>
        {editing ? (
          <button class="link strong" onClick={saveEdit}>
            Готово
          </button>
        ) : (
          <button class="link link-icon" onClick={() => setScanner(true)} aria-label="Сканировать QR-код чека">
            <IconQr />
          </button>
        )}
      </header>

      <div class={`amount ${shake ? 'shake' : ''}`} aria-live="polite">
        <div class="amount-expr">{receipt?.refund ? 'Возврат по чеку' : editingRefund ? 'Возврат' : hasOperator(expr) ? expr : ' '}</div>
        <div class={`amount-value num ${expr ? '' : 'is-empty'} ${negative ? 'is-refund' : ''}`} data-testid="amount">
          {formatMoney((negative ? -1 : 1) * (amount ?? 0), currency)}
        </div>
      </div>

      <div class="meta-row">
        <button class={`chip ${date === today ? 'is-on' : ''}`} onClick={() => setDate(today)}>
          Сегодня
        </button>
        <button class={`chip ${date === yesterday ? 'is-on' : ''}`} onClick={() => setDate(yesterday)}>
          Вчера
        </button>
        <label class={`chip chip-date ${customDate ? 'is-on' : ''}`}>
          <IconCalendar size={16} />
          {customDate && <span>{formatShortDate(date)}</span>}
          <input
            type="date"
            value={date}
            max={today}
            aria-label="Выбрать дату"
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              if (v) setDate(v);
            }}
          />
        </label>
        <button
          class={`chip chip-currency ${foreign ? 'is-on' : ''}`}
          onClick={() => setPicker(true)}
          aria-label={`Валюта: ${currency}. Сменить`}
          data-testid="currency"
        >
          {symbol !== currency && <span aria-hidden="true">{symbol}</span>} {currency}
        </button>
        {editing && (
          <button class="chip chip-danger" onClick={remove} aria-label="Удалить трату">
            <IconTrash size={16} />
          </button>
        )}
      </div>

      <input
        class="note-input"
        type="text"
        placeholder="Заметка"
        value={note}
        maxLength={120}
        enterKeyHint="done"
        onInput={(e) => setNote((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />

      {error ? (
        <div class="hint is-error" role="alert">
          {error}
        </div>
      ) : receipt ? (
        <div class={`hint ${duplicate ? 'is-warning' : ''}`} data-testid="receipt-line">
          {duplicate
            ? `Этот чек уже записан ${formatShortDate(duplicate.date)}: ${formatMoney(duplicate.amount)} · ${
                categories.find((c) => c.id === duplicate.categoryId)?.name ?? 'без категории'
              }`
            : `Чек от ${shortDay(receipt.date)}, ${receipt.time} — выбери категорию`}{' '}
          <button class="link" onClick={dropReceipt}>
            не из чека
          </button>
        </div>
      ) : foreign ? (
        <RateLine key={currentKey} currency={currency} date={date} amount={amount} state={shownRate} onManual={setManualRate} />
      ) : (
        !editing && <div class="hint">Выбери категорию — и трата сохранится</div>
      )}

      <div class="cat-grid">
        {visibleCategories.map((c) => (
          <button
            key={c.id}
            class={`cat-cell ${editing && c.id === categoryId ? 'is-on' : ''}`}
            onClick={() => (editing ? setCategoryId(c.id) : saveNew(c))}
          >
            <CategoryBadge category={c} />
            <span class="cat-name">{c.name}</span>
          </button>
        ))}
      </div>

      <div class="keypad">
        {KEYS.flat().map((k) => (
          <button
            key={k}
            class={`key ${/^\d+$/.test(k) || k === ',' ? '' : 'key-op'}`}
            onClick={() => press(k)}
            aria-label={k === 'back' ? 'Стереть' : k === 'clear' ? 'Очистить' : k}
          >
            {k === 'back' ? <IconBackspace /> : k === 'clear' ? 'C' : k}
          </button>
        ))}
      </div>

      {scanner && <ReceiptScanner onResult={applyReceipt} onClose={() => setScanner(false)} />}

      {picker && (
        <CurrencyPicker
          value={currency}
          onPick={(code) => {
            currencyTouched.current = true;
            setError(null);
            setCurrency(code);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}

/** Строка под заметкой: сколько это в рублях и откуда курс; по нажатию — ручной курс. */
function RateLine({
  currency,
  date,
  amount,
  state,
  onManual,
}: {
  currency: string;
  date: string;
  amount: number | null;
  state: RateState;
  onManual: (perUnit: number) => void;
}) {
  const [editingRate, setEditingRate] = useState(false);
  const [text, setText] = useState('');
  const info = state.info;
  const nominal = info ? displayNominal(info.rate) : 1;

  if (state.status === 'loading') return <div class="hint rate-line">Загружаю курс ЦБ…</div>;

  if (editingRate) {
    const submit = () => {
      const value = evalAmount(text.replace(/\s/g, ''));
      if (value === null || value <= 0) return;
      onManual(value / 100 / nominal);
      setEditingRate(false);
    };
    return (
      <form
        class="hint rate-line rate-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          inputMode="decimal"
          value={text}
          autoFocus
          aria-label={`Рублей за ${nominal} ${currency}`}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
        <span>
          ₽ за {nominal.toLocaleString('ru-RU')} {currency}
        </span>
        <button type="submit" class="link strong">
          Готово
        </button>
      </form>
    );
  }

  const openEditor = () => {
    setText(info ? minorToInput(Math.round(info.rate * nominal * 100)) : '');
    setEditingRate(true);
  };

  if (!info) {
    return (
      <div class="hint rate-line is-warning">
        Нет курса {currency} на {shortDay(date)} — сети нет{' '}
        <button class="link strong" onClick={openEditor}>
          Ввести курс
        </button>
      </div>
    );
  }

  const approx = amount && amount > 0 ? `≈ ${formatMoney(toRub(amount, info.rate))} · ` : '';
  const source =
    info.source === 'manual' ? 'вручную' : info.source === 'stale' ? `курс от ${shortDay(info.date)}, без сети` : `ЦБ, ${shortDay(info.date)}`;
  return (
    <div class={`hint rate-line ${info.source === 'stale' ? 'is-warning' : ''}`} data-testid="rate-line">
      {approx}
      {formatRate(info.rate, currency)} · {source}{' '}
      <button class="link" onClick={openEditor}>
        изменить
      </button>
    </div>
  );
}
