import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Category, Expense, Rule } from '../db/db';
import { allRules, alreadyImported, expensesNear, findImportProfile, importExpenses, learnRules, saveImportProfile } from '../db/imports';
import { suggestCategory, type Suggestion } from '../lib/autocat';
import { formatMoney, plural } from '../lib/money';
import { formatShortDate, monthShort } from '../lib/dates';
import { readStatementFile } from '../lib/spreadsheet';
import {
  findTable,
  guessMapping,
  headerSignature,
  importIds,
  isOwnTransfer,
  matchManual,
  parseRows,
  type Mapping,
  type StatementRow,
  type Table,
} from '../lib/statement';
import { showToast } from './toast';
import { IconBack } from './icons';

type Stage =
  | { kind: 'pick'; error?: string }
  | { kind: 'loading'; fileName: string }
  | { kind: 'review'; fileName: string; table: Table; signature: string; bank: string | null; known: boolean; mapping: Mapping }
  | { kind: 'done'; count: number; total: number; learned: number };

const ACCEPT = '.csv,.txt,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAGE = 150;

const shortDay = (iso: string) => `${Number(iso.slice(8, 10))} ${monthShort(iso.slice(0, 7))}`;

export function Import({ categoryList, onBack, onShowHistory }: { categoryList: Category[]; onBack: () => void; onShowHistory: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const fileInput = useRef<HTMLInputElement>(null);

  const openFile = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    fileInput.current!.value = '';
    if (/\.pdf$/i.test(file.name)) {
      setStage({ kind: 'pick', error: 'PDF пока не читается. В приложении банка выбери выгрузку в Excel или CSV.' });
      return;
    }
    setStage({ kind: 'loading', fileName: file.name });
    try {
      const grid = await readStatementFile(file.name, await file.arrayBuffer());
      const table = findTable(grid);
      if (!table) {
        setStage({ kind: 'pick', error: 'Не нашёл в файле таблицу с датой и суммой операций. Это точно выписка по карте или счёту?' });
        return;
      }
      const signature = headerSignature(table.headers);
      const guess = guessMapping(table);
      const saved = await findImportProfile(signature);
      setStage({
        kind: 'review',
        fileName: file.name,
        table,
        signature,
        bank: guess.bank,
        known: guess.confident || saved !== null,
        mapping: saved ?? guess.mapping,
      });
    } catch (err) {
      console.error(err);
      setStage({ kind: 'pick', error: 'Файл не читается. Сохрани выписку заново в формате CSV или XLSX.' });
    }
  };

  return (
    <div class="screen-body">
      <header class="nav-head">
        <button class="link nav-back" onClick={onBack}>
          <IconBack size={20} /> Настройки
        </button>
        <h1 class="nav-title">Импорт выписки</h1>
      </header>

      {stage.kind === 'pick' && (
        <>
          <p class="footnote lead">
            Выгрузи выписку в приложении банка (CSV или Excel), сохрани в «Файлы» и выбери её здесь. Траты появятся в истории, категории
            подберутся сами — проверишь их перед загрузкой.
          </p>
          {stage.error && (
            <div class="banner banner-error" role="alert">
              {stage.error}
            </div>
          )}
          <button class="btn" onClick={() => fileInput.current?.click()}>
            Выбрать файл выписки
          </button>
          <p class="footnote">
            Т-Банк узнаётся сам. Для другого банка один раз укажешь, где дата, сумма и описание, — в следующий раз настройка подхватится.
            Файл читается на телефоне и никуда не отправляется.
          </p>
        </>
      )}

      {stage.kind === 'loading' && <p class="footnote lead">Читаю {stage.fileName}…</p>}

      {stage.kind === 'review' && (
        <Review
          key={stage.fileName}
          stage={stage}
          categoryList={categoryList}
          onMapping={(mapping) => setStage({ ...stage, mapping })}
          onDone={(count, total, learned) => setStage({ kind: 'done', count, total, learned })}
          onCancel={() => setStage({ kind: 'pick' })}
        />
      )}

      {stage.kind === 'done' && (
        <div class="card import-done">
          <div class="import-done-title">Готово</div>
          <p>
            Загружено {stage.count} {plural(stage.count, 'трата', 'траты', 'трат')} на {formatMoney(stage.total)}.
            {stage.learned > 0 && ` Запомнил категории для ${stage.learned} ${plural(stage.learned, 'магазина', 'магазинов', 'магазинов')}.`}
          </p>
          <button class="btn" onClick={onShowHistory}>
            Открыть историю
          </button>
          <button class="btn btn-plain" onClick={() => setStage({ kind: 'pick' })}>
            Загрузить ещё выписку
          </button>
        </div>
      )}

      <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={() => void openFile()} data-testid="statement-file" />
    </div>
  );
}

interface Choice {
  include: boolean;
  categoryId: string;
  /** Категорию поменял человек — запомним правило для этого магазина. */
  changed: boolean;
}

function Review({
  stage,
  categoryList,
  onMapping,
  onDone,
  onCancel,
}: {
  stage: Extract<Stage, { kind: 'review' }>;
  categoryList: Category[];
  onMapping: (m: Mapping) => void;
  onDone: (count: number, total: number, learned: number) => void;
  onCancel: () => void;
}) {
  const { table, mapping } = stage;
  const [showMapping, setShowMapping] = useState(!stage.known);
  const [choices, setChoices] = useState(new Map<number, Choice>());
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [context, setContext] = useState<{ imported: Set<string>; matches: Map<number, Expense>; rules: Rule[] } | null>(null);

  const active = useMemo(() => categoryList.filter((c) => !c.archived), [categoryList]);
  const activeIds = useMemo(() => new Set(active.map((c) => c.id)), [active]);
  const parsed = useMemo(() => parseRows(table, mapping), [table, mapping]);
  const ids = useMemo(() => importIds(parsed.rows), [parsed]);

  useEffect(() => {
    let cancelled = false;
    setChoices(new Map());
    void (async () => {
      const dates = parsed.rows.map((r) => r.date).sort();
      const [imported, near, rules] = await Promise.all([
        alreadyImported(ids),
        dates.length ? expensesNear(dates[0], dates[dates.length - 1]) : Promise.resolve([]),
        allRules(),
      ]);
      if (!cancelled) setContext({ imported, matches: matchManual(parsed.rows, near), rules });
    })();
    return () => {
      cancelled = true;
    };
  }, [parsed, ids]);

  if (!context) return <p class="footnote lead">Сверяю с уже записанными тратами…</p>;

  const fresh = parsed.rows.map((row, i) => ({ row, id: ids[i] })).filter(({ id }) => !context.imported.has(id));
  const suggestions = new Map<number, Suggestion>(
    fresh.map(({ row }) => [row.index, suggestCategory(row.description, row.bankCategory, context.rules, activeIds)]),
  );
  const choiceOf = (row: StatementRow): Choice =>
    choices.get(row.index) ?? {
      include: !isOwnTransfer(row) && !context.matches.has(row.index),
      categoryId: suggestions.get(row.index)!.categoryId,
      changed: false,
    };
  const update = (row: StatementRow, patch: Partial<Choice>) => setChoices(new Map(choices).set(row.index, { ...choiceOf(row), ...patch }));

  const selected = fresh.filter(({ row }) => choiceOf(row).include);
  const total = selected.reduce((s, { row }) => s + row.amount, 0);
  const dates = fresh.map(({ row }) => row.date).sort();
  const categoriesById = new Map(categoryList.map((c) => [c.id, c]));

  const run = async () => {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    try {
      const count = await importExpenses(
        selected.map(({ row, id }) => ({ date: row.date, amount: row.amount, categoryId: choiceOf(row).categoryId, note: row.description, externalId: id })),
      );
      const learned = await learnRules(
        selected.filter(({ row }) => choiceOf(row).changed).map(({ row }) => ({ description: row.description, categoryId: choiceOf(row).categoryId })),
      );
      await saveImportProfile(stage.signature, stage.bank ?? stage.fileName, mapping);
      onDone(count, total, learned);
    } catch (err) {
      console.error(err);
      showToast('Не получилось загрузить — попробуй ещё раз');
    } finally {
      setBusy(false);
    }
  };

  const columnLabel = (i: number) => {
    const sample = table.rows[0]?.[i] ?? '';
    return `${table.headers[i] || `Колонка ${i + 1}`}${sample ? ` — ${sample.slice(0, 24)}` : ''}`;
  };
  const columns = Array.from({ length: Math.max(table.headers.length, table.rows[0]?.length ?? 0) }, (_, i) => i);
  const setCol = (key: 'date' | 'amount' | 'description' | 'bankCategory', value: string) =>
    onMapping({ ...mapping, [key]: value === '' ? null : Number(value) });

  const skipped = [
    context.imported.size && `уже загружены: ${parsed.rows.length - fresh.length}`,
    parsed.skippedIncome && `поступления: ${parsed.skippedIncome}`,
    parsed.skippedFailed && `отклонённые: ${parsed.skippedFailed}`,
    parsed.skippedInvalid && `служебные строки: ${parsed.skippedInvalid}`,
  ].filter(Boolean);

  return (
    <>
      <div class="card import-summary">
        <div class="import-summary-title">{stage.bank ?? stage.fileName}</div>
        {dates.length > 0 && (
          <div class="row-sub">
            {shortDay(dates[0])} — {shortDay(dates[dates.length - 1])} · новых трат: {fresh.length}
          </div>
        )}
        {skipped.length > 0 && <div class="row-sub">Пропущено — {skipped.join(', ')}</div>}
        <button class="link" onClick={() => setShowMapping(!showMapping)}>
          {showMapping ? 'Скрыть колонки' : 'Колонки: ' + [mapping.date, mapping.amount, mapping.description].map((i) => table.headers[i] || `№${i + 1}`).join(' · ')}
        </button>
      </div>

      {showMapping && (
        <div class="card form-card" data-testid="mapping">
          {(
            [
              ['date', 'Дата'],
              ['amount', 'Сумма'],
              ['description', 'Описание'],
              ['bankCategory', 'Категория банка'],
            ] as const
          ).map(([key, label]) => (
            <label class="field" key={key}>
              <span>{label}</span>
              <select value={mapping[key] ?? ''} onChange={(e) => setCol(key, (e.target as HTMLSelectElement).value)}>
                {key === 'bankCategory' && <option value="">Нет</option>}
                {columns.map((i) => (
                  <option key={i} value={i}>
                    {columnLabel(i)}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <div class="field">
            <span>Траты в выписке</span>
            <div class="segmented segmented-wide" role="group">
              <button class={mapping.sign === 'negative' ? 'is-on' : ''} onClick={() => onMapping({ ...mapping, sign: 'negative' })}>
                с минусом
              </button>
              <button class={mapping.sign === 'positive' ? 'is-on' : ''} onClick={() => onMapping({ ...mapping, sign: 'positive' })}>
                без знака
              </button>
            </div>
          </div>
        </div>
      )}

      {fresh.length === 0 ? (
        <div class="empty">
          <div class="empty-title">{parsed.rows.length ? 'Всё уже загружено' : 'Трат не нашлось'}</div>
          <div class="empty-text">
            {parsed.rows.length ? 'Все траты из этой выписки уже есть в истории.' : 'Проверь колонки: дата, сумма и знак трат.'}
          </div>
        </div>
      ) : (
        <div class="card import-list">
          {fresh.slice(0, limit).map(({ row }) => {
            const choice = choiceOf(row);
            const match = context.matches.get(row.index);
            const transfer = isOwnTransfer(row);
            const suggestion = suggestions.get(row.index)!;
            return (
              <div class={`import-row ${choice.include ? '' : 'is-off'}`} key={row.index}>
                <input
                  type="checkbox"
                  checked={choice.include}
                  aria-label={`Загрузить: ${row.description}, ${formatMoney(row.amount)}`}
                  onChange={(e) => update(row, { include: (e.target as HTMLInputElement).checked })}
                />
                <div class="row-main">
                  <div class="import-line">
                    <span class="row-title">{row.description || 'Без описания'}</span>
                    <span class="row-amount num">{formatMoney(row.amount)}</span>
                  </div>
                  <div class="import-line">
                    <span class="muted import-date">{shortDay(row.date)}</span>
                    <select
                      class={`cat-select ${suggestion.via === 'none' && !choice.changed ? 'is-guess' : ''}`}
                      value={choice.categoryId}
                      aria-label="Категория"
                      onChange={(e) => update(row, { categoryId: (e.target as HTMLSelectElement).value, changed: true, include: true })}
                    >
                      {active.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.emoji} {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {(match || transfer) && (
                    <div class="import-flag">
                      {match
                        ? `уже записано вручную: ${categoriesById.get(match.categoryId)?.name ?? ''}, ${formatShortDate(match.date)}`
                        : 'перевод между своими счетами — не трата'}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {fresh.length > limit && (
            <button class="btn btn-plain" onClick={() => setLimit(limit + PAGE)}>
              Показать ещё {Math.min(PAGE, fresh.length - limit)}
            </button>
          )}
        </div>
      )}

      <div class="import-bar">
        <button class="btn btn-plain" onClick={onCancel}>
          Другой файл
        </button>
        <button class="btn" disabled={selected.length === 0 || busy} onClick={() => void run()} data-testid="import-run">
          {busy ? 'Загружаю…' : `Загрузить ${selected.length} ${plural(selected.length, 'трату', 'траты', 'трат')} · ${formatMoney(total)}`}
        </button>
      </div>
    </>
  );
}
