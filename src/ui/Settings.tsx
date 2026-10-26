import { useEffect, useRef, useState } from 'preact/hooks';
import { db, type Category } from '../db/db';
import { getSetting, SETTING_LAST_BACKUP } from '../db/repo';
import { latestRateDate, recalcStaleExpenses, refreshRates } from '../db/rates';
import { parseBackup, restoreBackup } from '../lib/backup';
import { formatShortDate, toISODate } from '../lib/dates';
import { useLive } from '../lib/hooks';
import { Budgets } from './Budgets';
import { Categories } from './Categories';
import { Import } from './Import';
import { Templates } from './Templates';
import { saveBackupFile, saveCsvFile } from './files';
import { showToast } from './toast';
import { IconChevron } from './icons';

function useStorageInfo() {
  const [info, setInfo] = useState<{ persisted: boolean | null; usage: number | null }>({ persisted: null, usage: null });
  useEffect(() => {
    const s = navigator.storage;
    if (!s) return;
    Promise.all([s.persisted?.() ?? Promise.resolve(null), s.estimate?.() ?? Promise.resolve(null)]).then(([persisted, est]) =>
      setInfo({ persisted, usage: est?.usage ?? null }),
    );
  }, []);
  return info;
}

const formatBytes = (b: number) =>
  b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} КБ` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;

export function Settings({
  categoryList,
  categories,
  onShowHistory,
}: {
  categoryList: Category[];
  categories: Map<string, Category>;
  onShowHistory: () => void;
}) {
  const [screen, setScreen] = useState<'main' | 'categories' | 'templates' | 'budgets' | 'import'>('main');
  const lastBackup = useLive(() => getSetting<number | null>(SETTING_LAST_BACKUP, null), []);
  const counts = useLive(
    async () => ({ expenses: await db.expenses.count(), templates: await db.templates.count(), budgets: await db.budgets.count() }),
    [],
  );
  const count = counts?.expenses;
  const rateDate = useLive(() => latestRateDate(), []);
  const [ratesBusy, setRatesBusy] = useState(false);
  const storage = useStorageInfo();
  const fileInput = useRef<HTMLInputElement>(null);

  const back = () => setScreen('main');
  if (screen === 'categories') return <Categories categories={categoryList} onBack={back} />;
  if (screen === 'templates') return <Templates categories={categories} categoryList={categoryList} onBack={back} />;
  if (screen === 'budgets') return <Budgets categories={categories} categoryList={categoryList} onBack={back} />;
  if (screen === 'import') return <Import categoryList={categoryList} onBack={back} onShowHistory={onShowHistory} />;

  const run = (fn: () => Promise<void>) => () =>
    fn().catch((err) => {
      console.error(err);
      showToast(err instanceof Error ? err.message : 'Что-то пошло не так');
    });

  const onRestoreFile = run(async () => {
    const input = fileInput.current;
    const file = input?.files?.[0];
    if (!input || !file) return;
    input.value = '';
    const backup = parseBackup(await file.text());
    const date = formatShortDate(toISODate(new Date(backup.exportedAt)));
    const ok = window.confirm(
      `Заменить все данные бэкапом от ${date}?\n\nСейчас трат: ${count ?? 0}. В бэкапе: ${backup.tables.expenses.length}. Текущие данные будут удалены.`,
    );
    if (!ok) return;
    await restoreBackup(backup);
    showToast(`Восстановлено трат: ${backup.tables.expenses.length}`);
  });

  const updateRates = async () => {
    setRatesBusy(true);
    try {
      const date = await refreshRates();
      const fixed = await recalcStaleExpenses();
      showToast(
        date ? `Курсы ЦБ на ${formatShortDate(date)}${fixed ? ` · пересчитано трат: ${fixed}` : ''}` : 'ЦБ не вернул курсы',
      );
    } catch {
      showToast('Не получилось: нет сети или ЦБ недоступен');
    } finally {
      setRatesBusy(false);
    }
  };

  const wipe = run(async () => {
    if (!window.confirm('Удалить все траты, категории и настройки? Отменить это будет нельзя.')) return;
    if (!window.confirm('Точно удалить? Если бэкапа нет, данные пропадут навсегда.')) return;
    await db.delete();
    location.reload();
  });

  return (
    <div class="screen-body">
      <header class="screen-head">
        <h1 class="screen-title">Настройки</h1>
      </header>

      <div class="card">
        <button class="row" onClick={() => setScreen('categories')}>
          <span class="row-main row-title">Категории</span>
          <span class="row-value">{categoryList.filter((c) => !c.archived).length}</span>
          <IconChevron size={18} />
        </button>
        <button class="row" onClick={() => setScreen('templates')}>
          <span class="row-main row-title">Шаблоны</span>
          <span class="row-value">{counts?.templates || 'нет'}</span>
          <IconChevron size={18} />
        </button>
        <button class="row" onClick={() => setScreen('import')}>
          <span class="row-main row-title">Импорт выписки</span>
          <span class="row-value">CSV, Excel</span>
          <IconChevron size={18} />
        </button>
        <button class="row" onClick={() => setScreen('budgets')}>
          <span class="row-main row-title">Бюджеты</span>
          <span class="row-value">{counts?.budgets || 'нет'}</span>
          <IconChevron size={18} />
        </button>
      </div>

      <section class="group">
        <h3 class="group-head">
          <span>Курсы валют</span>
        </h3>
        <div class="card">
          <button class="row" onClick={run(updateRates)} disabled={ratesBusy}>
            <span class="row-main">
              <span class="row-title accent">{ratesBusy ? 'Загружаю…' : 'Обновить курсы ЦБ'}</span>
              <span class="row-sub">{rateDate ? `Сохранены курсы на ${formatShortDate(rateDate)}` : 'Курсы ещё не загружались'}</span>
            </span>
          </button>
        </div>
        <p class="footnote">
          Курс подтягивается сам, когда записываешь трату в валюте. В запросе к cbr-xml-daily.ru только дата — данные о тратах
          никуда не уходят.
        </p>
      </section>

      <section class="group">
        <h3 class="group-head">
          <span>Бэкап</span>
        </h3>
        <div class="card">
          <button class="row" onClick={run(saveBackupFile)}>
            <span class="row-main">
              <span class="row-title accent">Сохранить бэкап</span>
              <span class="row-sub">
                {lastBackup ? `Последний: ${formatShortDate(toISODate(new Date(lastBackup)))}` : 'Ещё ни разу не сохранялся'}
              </span>
            </span>
          </button>
          <button class="row" onClick={() => fileInput.current?.click()}>
            <span class="row-main row-title accent">Восстановить из файла</span>
          </button>
          <button class="row" onClick={run(saveCsvFile)}>
            <span class="row-main row-title accent">Выгрузить траты в CSV</span>
          </button>
        </div>
        <p class="footnote">
          Данные хранятся только на этом телефоне. Сохраняй бэкап в «Файлы» → iCloud Drive: если удалить иконку приложения,
          восстановить траты можно будет только из него.
        </p>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={onRestoreFile} />
      </section>

      <section class="group">
        <h3 class="group-head">
          <span>Хранилище</span>
        </h3>
        <div class="card">
          <div class="row">
            <span class="row-main row-title">Трат записано</span>
            <span class="row-value num">{count ?? '…'}</span>
          </div>
          {storage.usage !== null && (
            <div class="row">
              <span class="row-main row-title">Занято</span>
              <span class="row-value">{formatBytes(storage.usage)}</span>
            </div>
          )}
          {storage.persisted !== null && (
            <div class="row">
              <span class="row-main row-title">Защита от очистки</span>
              <span class="row-value">{storage.persisted ? 'включена' : 'нет'}</span>
            </div>
          )}
        </div>
      </section>

      <section class="group">
        <div class="card">
          <button class="row" onClick={wipe}>
            <span class="row-main row-title danger">Удалить все данные</span>
          </button>
        </div>
        <p class="footnote center">
          Расходы {__APP_VERSION__} · сборка {__BUILD_DATE__}
        </p>
      </section>
    </div>
  );
}
