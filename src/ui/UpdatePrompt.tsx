import { useEffect } from 'preact/hooks';
import { useRegisterSW } from 'virtual:pwa-register/preact';
import { showToast } from './toast';

const CHECK_EVERY_MS = 60 * 60 * 1000;

/** Плашка «Доступна новая версия». Данные в IndexedDB обновление не трогает. */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => void registration.update(), CHECK_EVERY_MS);
    },
  });

  useEffect(() => {
    if (!offlineReady) return;
    showToast('Готово: приложение работает и без интернета');
    setOfflineReady(false);
  }, [offlineReady]);

  if (!needRefresh) return null;
  return (
    <div class="update-bar">
      <span>Доступна новая версия</span>
      <button class="link" onClick={() => setNeedRefresh(false)}>
        Позже
      </button>
      <button class="btn btn-small" onClick={() => void updateServiceWorker(true)}>
        Обновить
      </button>
    </div>
  );
}
