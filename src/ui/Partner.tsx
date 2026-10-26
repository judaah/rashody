import { useEffect, useState } from 'preact/hooks';
import { getMyName, getPairing, getPartner, joinPairing, leavePairing, setMyName, startPairing, SyncError } from '../db/sync';
import { parsePairCode, pairCode, type PairSecret } from '../lib/pairing';
import { useLive } from '../lib/hooks';
import { QrScanSheet } from './QrScanSheet';
import { relay, runSync, SYNC_URL, useSyncStatus } from './syncRunner';
import { showToast } from './toast';
import { IconBack } from './icons';

const APP_URL = 'judaah.github.io/rashody';
const WAITING_POLL_MS = 5_000;

const SCAN_TEXT = {
  title: 'Код партнёра',
  hint: 'Наведи камеру на QR в приложении партнёра: «Настройки → Партнёр».',
  wrongCode: 'Это не QR приложения «Расходы» — попроси партнёра открыть «Настройки → Партнёр»',
  photoButton: 'Выбрать снимок экрана с QR',
  photoAction: 'выбери снимок экрана с QR',
};

function ago(ts: number, now = Date.now()): string {
  const min = Math.round((now - ts) / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

const errorText = (err: unknown) =>
  err instanceof SyncError ? err.message : err instanceof TypeError ? 'Нет связи с посредником. Проверь интернет и попробуй ещё раз.' : 'Что-то пошло не так';

/** QR с кодом пары. Генератор грузим только здесь. */
function PairQr({ code }: { code: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void import('qrcode').then((QR) => QR.toDataURL(code, { margin: 1, width: 560, errorCorrectionLevel: 'M' })).then(setSrc);
  }, [code]);
  return <div class="pair-qr">{src ? <img src={src} alt="QR-код для подключения партнёра" /> : <span class="muted">Рисую QR…</span>}</div>;
}

export function Partner({ onBack }: { onBack: () => void }) {
  const pairing = useLive(() => getPairing(), []);
  const partner = useLive(() => getPartner(), []);
  const savedName = useLive(() => getMyName(), []);
  const sync = useSyncStatus();
  const [name, setName] = useState<string | null>(null);
  const [mode, setMode] = useState<'main' | 'join' | 'scan'>('main');
  // QR после подключения прячется сам; показать снова — кнопкой (например, партнёр сменил телефон)
  const [showQr, setShowQr] = useState(false);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const waiting = !!pairing && !partner;
  // Пока ждём партнёра, проверяем чаще обычного — чтобы подключение было видно сразу.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void runSync(), WAITING_POLL_MS);
    return () => clearInterval(t);
  }, [waiting]);

  if (pairing === undefined || partner === undefined || savedName === undefined) return null;

  const nameValue = name ?? savedName;
  const saveName = async () => {
    if (name === null || name.trim() === savedName) return;
    await setMyName(name);
    setName(null);
    void runSync();
  };
  const needName = !nameValue.trim();

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const invite = () =>
    run(async () => {
      await saveName();
      await startPairing(relay());
    });

  const join = (secret: PairSecret | null) =>
    run(async () => {
      if (!secret) throw new SyncError('Код не распознан. Скопируй его целиком из сообщения партнёра.');
      await saveName();
      const state = await joinPairing(pairCode(secret), relay());
      setMode('main');
      setPasted('');
      showToast(state.partner ? `Подключено: ${state.partner.name || 'партнёр'}` : 'Подключено — ждём траты партнёра');
    });

  const disconnect = () =>
    run(async () => {
      const who = partner?.name ? ` (${partner.name})` : '';
      if (!window.confirm(`Отключить партнёра${who}? Твои траты перестанут быть видны партнёру, а траты партнёра пропадут с этого телефона.`)) return;
      await leavePairing(relay());
      setMode('main');
      setShowQr(false);
      showToast('Партнёр отключён');
    });

  const share = async (code: string) => {
    const text = `Подключись ко мне в «Расходах» (${APP_URL}): Настройки → Партнёр → «У меня есть код партнёра». Код: ${code}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(code);
        showToast('Код скопирован');
      }
    } catch {
      // закрыли меню «Поделиться»
    }
  };

  const code = pairing ? pairCode(pairing) : null;

  return (
    <div class="screen-body">
      <header class="nav-head">
        <button class="link nav-back" onClick={onBack}>
          <IconBack size={20} /> Настройки
        </button>
        <h1 class="nav-title">Партнёр</h1>
      </header>

      {!SYNC_URL ? (
        <p class="footnote lead">В этой сборке приложения обмен с партнёром не настроен.</p>
      ) : (
        <>
          <label class="field">
            <span>Твоё имя — его увидит партнёр</span>
            <input
              type="text"
              value={nameValue}
              maxLength={40}
              placeholder="Например, Дима"
              enterKeyHint="done"
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              onBlur={() => void saveName()}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              data-testid="my-name"
            />
          </label>

          {error && (
            <div class="banner banner-error" role="alert">
              {error}
            </div>
          )}

          {partner && (
            <div class="card partner-card" data-testid="partner-status">
              <div class="partner-card-name">{partner.name || 'Партнёр'}</div>
              <div class="row-sub">
                Обмен {ago(partner.syncedAt)} · последняя правка у партнёра {ago(partner.updatedAt)}
              </div>
              {sync.error && <div class="row-sub warn-text">{sync.error}</div>}
              <div class="partner-actions">
                <button class="btn btn-small" disabled={sync.running} onClick={() => void runSync()}>
                  {sync.running ? 'Обновляю…' : 'Обновить сейчас'}
                </button>
                <button class="btn btn-small btn-plain" onClick={() => setShowQr(!showQr)}>
                  {showQr ? 'Скрыть QR' : 'Показать QR'}
                </button>
              </div>
            </div>
          )}

          {code && (waiting || showQr) && (
            <section class="group" data-testid="invite">
              <h3 class="group-head">
                <span>{waiting ? 'Ждём партнёра' : 'QR для подключения'}</span>
              </h3>
              <div class="card invite-card">
                <PairQr code={code} />
                <ol class="invite-steps">
                  <li>
                    Партнёр ставит приложение: <b>{APP_URL}</b> в Safari → «Поделиться» → «На экран Домой».
                  </li>
                  <li>В приложении: «Настройки → Партнёр» → «У меня есть код партнёра» → сканирует этот QR.</li>
                </ol>
                <button class="btn btn-plain" onClick={() => void share(code)}>
                  Отправить код сообщением
                </button>
                <p class="footnote">
                  QR и код — это ключ к вашим тратам. Показывай их только партнёру. {waiting && 'Подключение появится здесь само.'}
                </p>
              </div>
            </section>
          )}

          {!pairing && mode !== 'join' && (
            <>
              <p class="footnote lead">
                Подключи партнёра — и вы будете видеть траты друг друга: каждый пишет со своего телефона. Траты шифруются на
                телефоне, посредник в Yandex Cloud видит только шифр.
              </p>
              <button class="btn" disabled={busy || needName} onClick={() => void invite()}>
                {busy ? 'Создаю…' : 'Пригласить партнёра'}
              </button>
              <button class="btn btn-plain" disabled={needName} onClick={() => setMode('join')}>
                У меня есть код партнёра
              </button>
              {needName && <p class="footnote center">Сначала впиши своё имя.</p>}
            </>
          )}

          {!pairing && mode === 'join' && (
            <section class="group">
              <button class="btn" disabled={busy} onClick={() => setMode('scan')}>
                Отсканировать QR партнёра
              </button>
              <label class="field paste-field">
                <span>…или вставь код из сообщения</span>
                <textarea
                  rows={3}
                  value={pasted}
                  placeholder="rsh1.…"
                  onInput={(e) => setPasted((e.target as HTMLTextAreaElement).value)}
                  data-testid="pair-code"
                />
              </label>
              <button class="btn btn-plain" disabled={busy || !pasted.trim()} onClick={() => void join(parsePairCode(pasted))}>
                {busy ? 'Подключаю…' : 'Подключиться'}
              </button>
              <button class="link" onClick={() => setMode('main')}>
                Назад
              </button>
            </section>
          )}

          {pairing && (
            <div class="card partner-danger">
              <button class="row" disabled={busy} onClick={() => void disconnect()}>
                <span class="row-main row-title danger">{partner ? 'Отключить партнёра' : 'Отменить приглашение'}</span>
              </button>
            </div>
          )}
        </>
      )}

      {mode === 'scan' && (
        <QrScanSheet
          text={SCAN_TEXT}
          parse={parsePairCode}
          onResult={(secret) => {
            setMode('join');
            void join(secret);
          }}
          onClose={() => setMode('join')}
        />
      )}
    </div>
  );
}
