import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Expense } from '../db/db';
import { allCategories } from '../db/repo';
import { useLive } from '../lib/hooks';
import { ExpenseEditor, type EditorState } from './ExpenseEditor';
import { Home } from './Home';
import { History } from './History';
import { Reports } from './Reports';
import { Settings } from './Settings';
import { showToast, Toasts } from './toast';
import { recalcStaleExpenses } from '../db/rates';
import { plural } from '../lib/money';
import { UpdatePrompt } from './UpdatePrompt';
import { IconChart, IconHome, IconList, IconPlus, IconSettings } from './icons';

type Tab = 'home' | 'history' | 'reports' | 'settings';

const TABS: Array<{ id: Tab; label: string; icon: () => preact.JSX.Element }> = [
  { id: 'home', label: 'Главная', icon: () => <IconHome /> },
  { id: 'history', label: 'История', icon: () => <IconList /> },
  { id: 'reports', label: 'Отчёты', icon: () => <IconChart /> },
  { id: 'settings', label: 'Настройки', icon: () => <IconSettings /> },
];

export function App() {
  const categoryList = useLive(() => allCategories(), []);
  const categories = useMemo(() => new Map((categoryList ?? []).map((c) => [c.id, c])), [categoryList]);
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

  // Траты, записанные без сети по старому курсу, пересчитываем по курсу ЦБ, как только есть сеть.
  useEffect(() => {
    const recalc = () =>
      void recalcStaleExpenses()
        .then((n) => n > 0 && showToast(`Пересчитано по курсу ЦБ: ${n} ${plural(n, 'трата', 'траты', 'трат')}`))
        .catch((err) => console.warn('recalc rates', err));
    recalc();
    window.addEventListener('online', recalc);
    return () => window.removeEventListener('online', recalc);
  }, []);

  if (!categoryList) return null;

  const openExpense = (expense: Expense) => setEditor({ mode: 'edit', expense });
  const showHistory = (category: string | null, month: string | null = null) => {
    setHistoryView((v) => ({ category, month, key: v.key + 1 }));
    setTab('history');
  };

  return (
    <div class="app">
      <main class="screen" ref={scroller}>
        <UpdatePrompt />
        {tab === 'home' && (
          <Home
            categories={categories}
            categoryList={categoryList}
            onOpen={openExpense}
            onOpenCategory={(id) => showHistory(id)}
            onShowHistory={() => showHistory(null)}
            onScanReceipt={() => setEditor({ mode: 'add', scan: true })}
          />
        )}
        {tab === 'history' && (
          <History
            key={historyView.key}
            categories={categories}
            categoryList={categoryList}
            initialCategory={historyView.category}
            initialMonth={historyView.month}
            onOpen={openExpense}
          />
        )}
        {tab === 'reports' && <Reports categories={categories} onOpenCategory={(id, ym) => showHistory(id, ym)} />}
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
      <Toasts />
    </div>
  );
}
