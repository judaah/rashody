import { useEffect, useRef, useState } from 'preact/hooks';
import { getMyName, getPairing, getPartner, joinPairing, leavePairing, setMyName, startPairing, SyncError } from '../db/sync';
import { pairLink, parsePairCode, pairCode, type PairSecret } from '../lib/pairing';
import { useLive } from '../lib/hooks';
import { QrScanSheet } from './QrScanSheet';
import { relay, runSync, SYNC_URL, useSyncStatus } from './syncRunner';
import { showToast } from './toast';
import { IconBack } from './icons';

// Адрес приложения: на него ведут QR и ссылка-приглашение.
const APP_URL = new URL(import.meta.env.BASE_URL, location.origin).href;
const WAITING_POLL_MS = 5_000;

const SCAN_TEXT = {
  title: 'QR партнёра',
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
  return new Date(ts).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
  });
}

const errorText = (err: unknown) =>
  err instanceof SyncError
    ? err.message
    : err instanceof TypeError
      ? 'Нет связи с посредником. Проверь интернет и попробуй ещё раз.'
      : 'Что-то пошло не так';

/** QR со ссылкой-приглашением: его открывает и обычная камера айфона. Генератор грузим только здесь. */
function PairQr({ link }: { link: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void import('qrcode')
      .then((QR) =>
        QR.toDataURL(link, {
          margin: 1,
          width: 560,
          errorCorrectionLevel: 'M',
        }),
      )
      .then(setSrc);
  }, [link]);
  return (
    <div class="pair-qr">
      {src ? <img src={src} alt="QR-код для подключения партнёра" /> : <span class="muted">Рисую QR…</span>}
    </div>
  );
}

/** inviteCode — приложение открыли по ссылке-приглашению: предлагаем подключиться к нему. */
export function Partner({ onBack, inviteCode = null }: { onBack: () => void; inviteCode?: string | null }) {
  const pairing = useLive(() => getPairing(), []);
  const partner = useLive(() => getPartner(), []);
  const savedName = useLive(() => getMyName(), []);
  const sync = useSyncStatus();
  const [name, setName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // QR после подключения прячется сам; показать снова — кнопкой (например, партнёр сменил телефон)
  const [showQr, setShowQr] = useState(false);
  const [manual, setManual] = useState(false);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const manualInput = useRef<HTMLTextAreaElement>(null);

  const waiting = !!pairing && !partner;
  // Пока ждём партнёра, проверяем чаще обычного — чтобы подключение было видно сразу.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void runSync(), WAITING_POLL_MS);
    return () => clearInterval(t);
  }, [waiting]);

  useEffect(() => {
    if (manual) manualInput.current?.focus();
  }, [manual]);

  if (pairing === undefined || partner === undefined || savedName === undefined) return null;

  const nameValue = name ?? savedName;
  const saveName = async () => {
    if (name === null || name.trim() === savedName) return;
    await setMyName(name);
    setName(null);
    void runSync();
  };

  /** Имя нужно партнёру, чтобы понимать, чьи траты. Без него не молчим, а говорим, что делать. */
  const requireName = () => {
    if (nameValue.trim()) return true;
    setError('Сначала впиши своё имя — его увидит партнёр.');
    nameInput.current?.focus();
    return false;
  };

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

  const invite = () => {
    if (!requireName()) return;
    void run(async () => {
      await saveName();
      await startPairing(relay());
    });
  };

  const join = (secret: PairSecret | null) => {
    if (!secret) {
      setManual(true);
      setError('Код не распознан. Скопируй ссылку из сообщения партнёра целиком.');
      return;
    }
    if (!requireName()) {
      setPasted(pairCode(secret));
      setManual(true);
      return;
    }
    if (partner && pairing?.pairId !== secret.pairId) {
      const ok = window.confirm(`Сейчас подключён ${partner.name || 'партнёр'}. Отключить и подключиться по новому приглашению?`);
      if (!ok) return;
    }
    void run(async () => {
      await saveName();
      const state = await joinPairing(pairCode(secret), relay());
      setManual(false);
      setPasted('');
      setShowQr(false);
      showToast(state.partner ? `Подключено: ${state.partner.name || 'партнёр'}` : 'Подключено — ждём траты партнёра');
    });
  };

  // Буфер читаем по нажатию: iOS покажет кнопку «Вставить» — её надо нажать.
  const pasteAndJoin = async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // нет доступа к буферу — вставят руками
    }
    const secret = parsePairCode(text);
    if (secret) return join(secret);
    setManual(true);
    setError(
      text
        ? 'В буфере нет приглашения. Скопируй ссылку из сообщения партнёра целиком — или вставь её в поле ниже.'
        : 'Не получилось прочитать буфер. Нажми на поле ниже и выбери «Вставить».',
    );
  };

  const disconnect = () =>
    run(async () => {
      const who = partner?.name ? ` (${partner.name})` : '';
      if (
        !window.confirm(
          `Отключить партнёра${who}? Твои траты перестанут быть видны партнёру, а траты партнёра пропадут с этого телефона.`,
        )
      )
        return;
      await leavePairing(relay());
      setShowQr(false);
      showToast('Партнёр отключён');
    });

  const share = async (link: string) => {
    const text = `Подключись ко мне в «Расходах»: ${link}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else await copyLink(link);
    } catch {
      // закрыли меню «Поделиться»
    }
  };

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      showToast('Ссылка скопирована');
    } catch {
      showToast('Не получилось скопировать');
    }
  };

  const link = pairing ? pairLink(pairing, APP_URL) : null;
  // Приглашение из ссылки, которой открыли приложение. Своё же (или уже принятое) не предлагаем.
  const invited = inviteCode ? parsePairCode(inviteCode) : null;
  const offerInvite = invited && invited.pairId !== pairing?.pairId ? invited : null;

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
          {!pairing && !offerInvite && (
            <p class="footnote lead">
              Подключи партнёра — и вы будете видеть траты друг друга: каждый пишет со своего телефона. Траты шифруются на
              телефоне, посредник в Yandex Cloud видит только шифр.
            </p>
          )}

          <label class="field">
            <span>Твоё имя — его увидит партнёр</span>
            <input
              ref={nameInput}
              type="text"
              value={nameValue}
              maxLength={40}
              placeholder="Например, Дима"
              enterKeyHint="done"
              onInput={(e) => {
                setName((e.target as HTMLInputElement).value);
                setError(null);
              }}
              onBlur={() => void saveName()}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              data-testid="my-name"
            />
          </label>

          {error && (
            <div class="banner banner-error" role="alert" data-testid="partner-error">
              {error}
            </div>
          )}

          {offerInvite && (
            <div class="card invite-offer" data-testid="invite-offer">
              <div class="invite-offer-title">Тебя пригласили</div>
              <p class="row-sub">Нажми «Подключиться» — и вы будете видеть траты друг друга.</p>
              <button class="btn" disabled={busy} onClick={() => join(offerInvite)} data-testid="accept-invite">
                {busy ? 'Подключаю…' : 'Подключиться'}
              </button>
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

          {!pairing && !offerInvite && (
            <button class="btn" disabled={busy} onClick={invite} data-testid="start-invite">
              {busy ? 'Создаю…' : 'Пригласить партнёра'}
            </button>
          )}

          {link && (waiting || showQr) && (
            <section class="group" data-testid="invite">
              <h3 class="group-head">
                <span>{waiting ? 'Покажи этот QR партнёру' : 'QR для подключения'}</span>
              </h3>
              <div class="card invite-card">
                <PairQr link={link} />
                <ol class="invite-steps">
                  <li>
                    Партнёр наводит на QR <b>обычную камеру айфона</b> и открывает ссылку — там подсказка, как поставить
                    приложение и подключиться.
                  </li>
                  <li>Если «Расходы» у партнёра уже стоят: «Настройки → Партнёр» → «Отсканировать QR».</li>
                </ol>
                <div class="invite-actions">
                  <button class="btn btn-small" onClick={() => void share(link)} data-testid="share-invite">
                    Отправить
                  </button>
                  <button class="btn btn-small btn-plain" onClick={() => void copyLink(link)}>
                    Скопировать
                  </button>
                </div>
                <p class="footnote">
                  QR и ссылка — ключ к вашим тратам. Отправляй их только партнёру.{' '}
                  {waiting && 'Когда партнёр подключится, это появится здесь само.'}
                </p>
              </div>
            </section>
          )}

          {!partner && !offerInvite && (
            <section class="group" data-testid="join">
              <h3 class="group-head">
                <span>{pairing ? 'Или партнёр уже пригласил тебя?' : 'Партнёр уже пригласил тебя?'}</span>
              </h3>
              <div class="card join-card">
                <button class="row" disabled={busy} onClick={() => void pasteAndJoin()} data-testid="paste-invite">
                  <span class="row-main">
                    <span class="row-title accent">Вставить ссылку или код</span>
                    <span class="row-sub">скопируй ссылку от партнёра и нажми сюда</span>
                  </span>
                </button>
                <button class="row" disabled={busy} onClick={() => setScanning(true)} data-testid="scan-invite">
                  <span class="row-main">
                    <span class="row-title accent">Отсканировать QR</span>
                    <span class="row-sub">с экрана телефона партнёра</span>
                  </span>
                </button>
              </div>
              {!manual ? (
                <button class="link join-manual-toggle" onClick={() => setManual(true)}>
                  Ввести код вручную
                </button>
              ) : (
                <>
                  <label class="field paste-field">
                    <span>Ссылка или код приглашения</span>
                    <textarea
                      ref={manualInput}
                      rows={3}
                      value={pasted}
                      placeholder="https://…#join=rsh1… или rsh1.…"
                      onInput={(e) => {
                        setPasted((e.target as HTMLTextAreaElement).value);
                        setError(null);
                      }}
                      data-testid="pair-code"
                    />
                  </label>
                  <button
                    class="btn"
                    disabled={busy || !pasted.trim()}
                    onClick={() => join(parsePairCode(pasted))}
                    data-testid="join-manual"
                  >
                    {busy ? 'Подключаю…' : 'Подключиться'}
                  </button>
                </>
              )}
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

      {scanning && (
        <QrScanSheet
          text={SCAN_TEXT}
          parse={parsePairCode}
          onResult={(secret) => {
            setScanning(false);
            join(secret);
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  );
}
