import { useState } from 'preact/hooks';
import { recentCurrencies } from '../db/rates';
import { RUB } from '../lib/money';
import { CBR_CURRENCIES, currencyName, currencySymbol } from '../lib/rates';
import { useLive } from '../lib/hooks';
import { IconSearch } from './icons';

function CurrencyRow({ code, selected, onPick }: { code: string; selected: boolean; onPick: (code: string) => void }) {
  const symbol = currencySymbol(code);
  return (
    <button class={`row currency-row ${selected ? 'is-on' : ''}`} onClick={() => onPick(code)} aria-pressed={selected}>
      <span class="currency-symbol" aria-hidden="true">
        {symbol.length <= 2 ? symbol : code.slice(0, 1)}
      </span>
      <span class="row-main">
        <span class="row-title">{currencyName(code)}</span>
      </span>
      <span class="row-value">{code}</span>
      {selected && <span class="check" aria-hidden="true">✓</span>}
    </button>
  );
}

export function CurrencyPicker({ value, onPick, onClose }: { value: string; onPick: (code: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const recent = useLive(() => recentCurrencies(), []) ?? [];
  const q = query.trim().toLowerCase();
  const all = [RUB, ...CBR_CURRENCIES];
  const matches = q ? all.filter((c) => c.toLowerCase().includes(q) || currencyName(c).toLowerCase().includes(q)) : all;
  const top = q ? [] : [RUB, ...recent];
  const rest = matches.filter((c) => !top.includes(c));
  const pick = (code: string) => {
    onPick(code);
    onClose();
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Валюта">
      <header class="sheet-head">
        <button class="link" onClick={onClose}>
          Отмена
        </button>
        <span class="sheet-title">Валюта</span>
        <span class="link-placeholder" />
      </header>
      <label class="search">
        <IconSearch size={18} />
        <input type="search" placeholder="Доллар, евро, KZT…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
      </label>
      <div class="form">
        {top.length > 0 && (
          <section class="group">
            <h3 class="group-head">
              <span>{recent.length ? 'Недавние' : 'Основная'}</span>
            </h3>
            <div class="card">
              {top.map((c) => (
                <CurrencyRow key={c} code={c} selected={c === value} onPick={pick} />
              ))}
            </div>
          </section>
        )}
        <section class="group">
          {!q && (
            <h3 class="group-head">
              <span>Все валюты ЦБ</span>
            </h3>
          )}
          {rest.length === 0 ? (
            <p class="footnote">Такой валюты нет в списке ЦБ.</p>
          ) : (
            <div class="card">
              {rest.map((c) => (
                <CurrencyRow key={c} code={c} selected={c === value} onPick={pick} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
