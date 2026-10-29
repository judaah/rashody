import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { App } from './ui/App';
import { isStandalone, JoinLanding } from './ui/JoinLanding';
import { codeFromHash, pairCode } from './lib/pairing';
import './styles.css';

// Просим iOS не вычищать IndexedDB при нехватке места.
navigator.storage?.persist?.().catch(() => undefined);

/**
 * Код из ссылки-приглашения (…#join=rsh1…). Из адреса его убираем сразу,
 * чтобы он не остался в истории и не попал в закладку «На экран Домой».
 */
function takeInvite(): string | null {
  const invite = codeFromHash(location.hash);
  if (!invite) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return pairCode(invite);
}

const firstInvite = takeInvite();

function Root() {
  const [invite, setInvite] = useState(firstInvite);
  // В Safari — страница с подсказкой «скопируй код и вставь в приложении»;
  // в приложении с домашнего экрана (или если решили остаться в браузере) — сразу экран «Партнёр» с этим кодом.
  const [landing, setLanding] = useState(!!firstInvite && !isStandalone());

  // Ссылку открыли во вкладке, где приложение уже запущено: страница не перезагружается, меняется только «#».
  useEffect(() => {
    const onHash = () => {
      const code = takeInvite();
      if (!code) return;
      setInvite(code);
      setLanding(!isStandalone());
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  if (landing && invite) return <JoinLanding code={invite} onContinue={() => setLanding(false)} />;
  // key: новое приглашение — заново открываем «Настройки → Партнёр»
  return <App key={invite ?? ''} inviteCode={invite} />;
}

render(<Root />, document.getElementById('app')!);
