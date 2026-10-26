import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { db, type Expense } from '../db/db';
import { allCategories, getSetting } from '../db/repo';
import { mergeCategories, type OwnedExpense, type Scope } from '../db/scope';
import { getPairing, getPartner } from '../db/sync';
import { useLive } from '../lib/hooks';
import { ExpenseEditor, type EditorState } from './ExpenseEditor';
import { Home } from './Home';
import { History } from './History';
import { Reports } from './Reports';
import { Settings } from './Settings';
import { showToast, Toasts } from './toast';
import { autoRefreshRates, latestRate, recalcStaleExpenses } from '../db/rates';
import { DisplayCurrencyProvider, RUB_DISPLAY, SETTING_DISPLAY_CURRENCY } from './displayMoney';
import { plural, RUB } from '../lib/money';
import { UpdatePrompt } from './UpdatePrompt';
import { initialOf, PartnerExpenseView, ScopeSwitch } from './partnerUi';
import { useSyncScheduler } from './syncRunner';
import { IconChart, IconHome, IconList, IconPlus, IconSettings } from './icons';

type Tab = 'home' | 'history' | 'reports' | 'settings';

const TABS: Array<{ id: Tab; label: string; icon: () => preact.JSX.Element }> = [
  { id: 'home', label: 'Главная', icon: () => <IconHome /> },
  { id: 'history', label: 'История', icon: () => <IconList /> },
  { id: 'reports', label: 'Отчёты', icon: () => <IconChart /> },
  { id: 'settings', label: 'Настройки', icon: () => <IconSettings /> },
];

const SCOPE_KEY = 'rashody.scope';

function savedScope(): Scope {
  try {
    const v = localStorage.getItem(SCOPE_KEY);
    return v === 'partner' || v === 'together' ? v : 'me';
  } catch {
    return 'me';
  }
}

export function App() {
  const categoryList = useLive(() => allCategories(), []);
  const partnerCategories = useLive(() => db.partnerCategories.toArray(), []);
  const pairing = useLive(() => getPairing(), []);
  const partner = useLive(() => getPartner(), []);
  // Мои категории + свои категории партнёра: чтобы его траты показывались с его значками.
  const allCats = useMemo(() => mergeCategories(categoryList ?? [], partnerCategories ?? []), [categoryList, partnerCategories]);
  const categories = useMemo(() => new Map(allCats.map((c) => [c.id, c])), [allCats]);
  const [scopeChoice, setScopeChoice] = useState<Scope>(savedScope);
  const [partnerView, setPartnerView] = useState<OwnedExpense | null>(null);
  useSyncScheduler(!!pairing);
  const [tab, setTab] = useState<Tab>('home');
  const [editor, setEditor] = useState<EditorState | null>(null);
  // key заставляет «Историю» начать заново с нужным фильтром категории и месяцем.
  const [historyView, setHistoryView] = useState<{ category: string | null; month: string | null; key: number }>({
    category: null,
    month: null,
    key: 0,
  });
  const scroller = useRef<HTMLElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo(0, 0);
  }, [tab, historyView.key]);

  // Курсы ЦБ обновляются сами (не чаще раза в 6 часов), а траты, записанные без сети
  // по старому курсу, пересчитываются, как только курс на их дату доступен.
  useEffect(() => {
    const tick = () =>
      void autoRefreshRates()
        .then(() => recalcStaleExpenses())
        .then((n) => n > 0 && showToast(`Пересчитано по курсу ЦБ: ${n} ${plural(n, 'трата', 'траты', 'трат')}`))
        .catch((err) => console.warn('rates', err));
    const onVisible = () => document.visibilityState === 'visible' && tick();
    tick();
    const timer = setInterval(tick, 60 * 60 * 1000);
    window.addEventListener('online', tick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Валюта просмотра и её последний курс; без курса — пока показываем в рублях.
  const display = useLive(async () => {
    const code = await getSetting<string>(SETTING_DISPLAY_CURRENCY, RUB);
    if (code === RUB) return RUB_DISPLAY;
    const rate = await latestRate(code);
    return rate ? { code, rate: rate.rate, rateDate: rate.date } : RUB_DISPLAY;
  }, []);

  if (!categoryList) return null;

  // Переключатель «Я / Партнёр / Вместе» есть, только когда партнёр подключён.
  const hasPartner = !!partner;
  const scope: Scope = hasPartner ? scopeChoice : 'me';
  const partnerName = partner?.name || 'Партнёр';
  const setScope = (s: Scope) => {
    setScopeChoice(s);
    try {
      localStorage.setItem(SCOPE_KEY, s);
    } catch {
      // приватный режим — просто не запомним выбор
    }
  };

  const openExpense = (expense: Expense | OwnedExpense) =>
    'owner' in expense && expense.owner === 'partner' ? setPartnerView(expense) : setEditor({ mode: 'edit', expense });
  const showHistory = (category: string | null, month: string | null = null) => {
    setHistoryView((v) => ({ category, month, key: v.key + 1 }));
    setTab('history');
  };

  return (
    <DisplayCurrencyProvider value={display ?? RUB_DISPLAY}>
    <div class="app">
      <main class="screen" ref={scroller}>
        <UpdatePrompt />
        {hasPartner && tab !== 'settings' && <ScopeSwitch scope={scope} onChange={setScope} partnerName={partnerName} />}
        {tab === 'home' && (
          <Home
            categories={categories}
            categoryList={categoryList}
            onOpen={openExpense}
            onOpenCategory={(id) => showHistory(id)}
            onShowHistory={() => showHistory(null)}
            onScanReceipt={() => setEditor({ mode: 'add', scan: true })}
            scope={scope}
            partnerName={partnerName}
            partnerMark={initialOf(partnerName)}
          />
        )}
        {tab === 'history' && (
          <History
            key={historyView.key}
            categories={categories}
            categoryList={allCats}
            initialCategory={historyView.category}
            initialMonth={historyView.month}
            onOpen={openExpense}
            scope={scope}
            partnerMark={initialOf(partnerName)}
          />
        )}
        {tab === 'reports' && <Reports categories={categories} onOpenCategory={(id, ym) => showHistory(id, ym)} scope={scope} />}
        {tab === 'settings' && <Settings categoryList={categoryList} categories={categories} onShowHistory={() => showHistory(null)} />}
      </main>

      {tab !== 'settings' && (
        <button class="fab" onClick={() => setEditor({ mode: 'add' })} aria-label="Добавить трату">
          <IconPlus size={30} />
        </button>
      )}

      <nav class="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            class={`tab ${tab === t.id ? 'is-on' : ''}`}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => (t.id === 'history' ? showHistory(null) : setTab(t.id))}
          >
            {t.icon()}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {editor && <ExpenseEditor state={editor} categories={categoryList} onClose={() => setEditor(null)} />}
      {partnerView && (
        <PartnerExpenseView
          expense={partnerView}
          category={categories.get(partnerView.categoryId)}
          partnerName={partnerName}
          onClose={() => setPartnerView(null)}
        />
      )}
      <Toasts />
    </div>
    </DisplayCurrencyProvider>
  );
}
