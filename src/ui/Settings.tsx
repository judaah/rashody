import { useEffect, useRef, useState } from 'preact/hooks';
import { db, type Category } from '../db/db';
import { getSetting, setSetting, SETTING_LAST_BACKUP } from '../db/repo';
import { latestRate, latestRateDate, recalcStaleExpenses, refreshRates, SETTING_RATES_REFRESHED } from '../db/rates';
import { RUB } from '../lib/money';
import { formatRate } from '../lib/rates';
import { CurrencyPicker } from './CurrencyPicker';
import { SETTING_DISPLAY_CURRENCY } from './displayMoney';
import { parseBackup, restoreBackup } from '../lib/backup';
import { formatShortDate, toISODate } from '../lib/dates';
import { useLive } from '../lib/hooks';
import { Budgets } from './Budgets';
import { Categories } from './Categories';
import { Import } from './Import';
import { Partner } from './Partner';
import { getPartner } from '../db/sync';
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

/** «сегодня в 15:30» или «24 октября». */
function refreshedText(ts: number): string {
  const d = new Date(ts);
  if (toISODate(d) === toISODate(new Date())) return `сегодня в ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  return formatShortDate(toISODate(d));
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
  const [screen, setScreen] = useState<'main' | 'categories' | 'templates' | 'budgets' | 'import' | 'partner'>('main');
  const partner = useLive(() => getPartner(), []);
  const lastBackup = useLive(() => getSetting<number | null>(SETTING_LAST_BACKUP, null), []);
  const counts = useLive(
    async () => ({ expenses: await db.expenses.count(), templates: await db.templates.count(), budgets: await db.budgets.count() }),
    [],
  );
  const count = counts?.expenses;
  const displayCode = useLive(() => getSetting<string>(SETTING_DISPLAY_CURRENCY, RUB), []) ?? RUB;
  const rates = useLive(
    async () => ({
      date: await latestRateDate(),
      refreshedAt: await getSetting<number | null>(SETTING_RATES_REFRESHED, null),
      displayRate: displayCode === RUB ? null : await latestRate(displayCode),
    }),
    [displayCode],
  );
  const [currencyPicker, setCurrencyPicker] = useState(false);
  const [ratesBusy, setRatesBusy] = useState(false);
  const storage = useStorageInfo();
  const fileInput = useRef<HTMLInputElement>(null);

  const back = () => setScreen('main');
  if (screen === 'categories') return <Categories categories={categoryList} onBack={back} />;
  if (screen === 'templates') return <Templates categories={categories} categoryList={categoryList} onBack={back} />;
  if (screen === 'budgets') return <Budgets categories={categories} categoryList={categoryList} onBack={back} />;
  if (screen === 'partner') return <Partner onBack={back} />;
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

  const pickDisplay = async (code: string) => {
    await setSetting(SETTING_DISPLAY_CURRENCY, code);
    if (code === RUB || (await latestRate(code))) return;
    // курса этой валюты ещё не было — пробуем загрузить сразу
    try {
      await refreshRates();
    } catch {
      // нет сети — ниже скажем
    }
    if (!(await latestRate(code))) showToast(`Курса ${code} пока нет — итоги останутся в рублях, пока он не загрузится`);
  };

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

      <div class="card partner-entry">
        <button class="row" onClick={() => setScreen('partner')} data-testid="open-partner">
          <span class="row-main">
            <span class="row-title">Партнёр</span>
            <span class="row-sub">{partner ? `Подключён: ${partner.name || 'партнёр'}` : 'Видеть траты друг друга'}</span>
          </span>
          <IconChevron size={18} />
        </button>
      </div>

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
          <span>Валюта и курсы</span>
        </h3>
        <div class="card">
          <button class="row" onClick={() => setCurrencyPicker(true)} data-testid="display-currency">
            <span class="row-main">
              <span class="row-title">Валюта для итогов</span>
              <span class="row-sub">
                {displayCode === RUB
                  ? 'итоги, отчёты и бюджеты — в рублях'
                  : rates?.displayRate
                    ? `пересчёт по курсу ЦБ: ${formatRate(rates.displayRate.rate, displayCode)}`
                    : 'курса ещё нет — пока показываю в рублях'}
              </span>
            </span>
            <span class="row-value">{displayCode}</span>
            <IconChevron size={18} />
          </button>
          <button class="row" onClick={run(updateRates)} disabled={ratesBusy}>
            <span class="row-main">
              <span class="row-title accent">{ratesBusy ? 'Загружаю…' : 'Обновить курсы ЦБ'}</span>
              <span class="row-sub">
                {rates?.date
                  ? `на ${formatShortDate(rates.date)}${rates.refreshedAt ? ` · обновлены ${refreshedText(rates.refreshedAt)}` : ''}`
                  : 'курсы ещё не загружались'}
              </span>
            </span>
          </button>
        </div>
        <p class="footnote">
          Курсы обновляются сами: при запуске и раз в 6 часов, пока приложение открыто. Итоги в другой валюте считаются по
          последнему курсу ЦБ. В запросе к cbr-xml-daily.ru только дата — данные о тратах никуда не уходят.
        </p>
        {currencyPicker && <CurrencyPicker value={displayCode} onPick={(code) => void pickDisplay(code)} onClose={() => setCurrencyPicker(false)} />}
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
