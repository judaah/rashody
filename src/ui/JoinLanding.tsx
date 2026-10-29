import { useState } from 'preact/hooks';

/** Открыто ли приложение с домашнего экрана (а не во вкладке Safari). */
export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

/**
 * Страница, на которую ведут QR и ссылка-приглашение, если их открыли в Safari (камерой айфона
 * или из мессенджера). Подключиться прямо здесь нельзя: у приложения на домашнем экране своё
 * хранилище, отдельное от Safari. Поэтому — скопировать код и вставить его в приложении.
 */
export function JoinLanding({ code, onContinue }: { code: string; onContinue: () => void }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div class="app">
      <main class="screen">
        <div class="screen-body join-landing" data-testid="join-landing">
          <img class="join-logo" src={`${import.meta.env.BASE_URL}pwa-192x192.png`} alt="" width={72} height={72} />
          <h1 class="join-title">Тебя приглашают в «Расходы»</h1>
          <p class="join-lead">Вы будете видеть траты друг друга: каждый записывает со своего телефона.</p>

          <ol class="join-steps">
            <li>
              <b>Поставь приложение</b>, если его ещё нет: внизу Safari «Поделиться» → «На экран Домой» → «Добавить».
            </li>
            <li>
              <b>Скопируй код приглашения:</b>
              <button class={`btn ${copied === 'yes' ? 'btn-done' : ''}`} onClick={() => void copy()} data-testid="copy-code">
                {copied === 'yes' ? 'Код скопирован ✓' : 'Скопировать код'}
              </button>
              {copied === 'failed' && (
                <span class="join-manual">
                  Не получилось скопировать автоматически. Выдели код ниже и скопируй вручную:
                  <code class="join-code">{code}</code>
                </span>
              )}
            </li>
            <li>
              <b>Открой «Расходы» с иконки</b> → «Настройки» → «Партнёр» → «Вставить ссылку или код».
            </li>
          </ol>

          <p class="footnote">
            Подключиться прямо здесь, в Safari, не получится: у приложения на домашнем экране свои данные, отдельно от Safari.
          </p>
          <button class="link join-continue" onClick={onContinue} data-testid="join-in-browser">
            Пользоваться прямо в браузере
          </button>
        </div>
      </main>
    </div>
  );
}
