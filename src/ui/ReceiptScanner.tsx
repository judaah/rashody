import { useEffect, useRef, useState } from 'preact/hooks';
import type QrScanner from 'qr-scanner';
import { parseReceiptQr, type Receipt } from '../lib/receipt';
import { IconQr } from './icons';

// Библиотеку грузим только когда открыт сканер — основной код остаётся лёгким.
const loadQrScanner = () => import('qr-scanner').then((m) => m.default);

function cameraErrorText(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  const text = String(err instanceof Error ? err.message : err);
  if (name === 'NotAllowedError' || /permission|denied/i.test(text)) {
    return 'Нет доступа к камере. Разреши его в настройках iPhone (Safari → Камера) или выбери фото чека.';
  }
  if (!window.isSecureContext) return 'Камера работает только на https-адресе. Пока можно выбрать фото чека.';
  if (/not found|no camera/i.test(text)) return 'Камера не найдена. Выбери фото чека.';
  return 'Камера не запустилась. Выбери фото чека.';
}

const NOT_RECEIPT = 'Это не QR кассового чека — наведи на код внизу чека';

export function ReceiptScanner({ onResult, onClose }: { onResult: (r: Receipt) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const done = useRef(false);
  const [camera, setCamera] = useState<'starting' | 'on' | 'off'>('starting');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** true — это чек, сканер закрывается. */
  const accept = (text: string): boolean => {
    if (done.current) return true;
    const receipt = parseReceiptQr(text);
    if (!receipt) {
      setMessage(NOT_RECEIPT);
      return false;
    }
    done.current = true;
    scannerRef.current?.stop();
    onResult(receipt);
    return true;
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const Scanner = await loadQrScanner();
        if (cancelled || !video.current) return;
        const scanner = new Scanner(video.current, (result) => void accept(result.data), {
          returnDetailedScanResult: true,
          preferredCamera: 'environment',
          maxScansPerSecond: 8,
        });
        scannerRef.current = scanner;
        await scanner.start();
        if (!cancelled) setCamera('on');
      } catch (err) {
        if (cancelled) return;
        setCamera('off');
        setMessage(cameraErrorText(err));
      }
    })();
    return () => {
      cancelled = true;
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
  }, []);

  const scanPhoto = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    fileInput.current!.value = '';
    setBusy(true);
    setMessage(null);
    try {
      const Scanner = await loadQrScanner();
      const result = await Scanner.scanImage(file, { returnDetailedScanResult: true, alsoTryWithoutScanRegion: true });
      accept(result.data);
    } catch {
      setMessage('На фото не нашёлся QR-код. Сними ближе, чтобы код был резким и целиком в кадре.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sheet scanner" role="dialog" aria-modal="true" aria-label="Сканирование чека">
      <header class="sheet-head">
        <button class="link" onClick={onClose}>
          Отмена
        </button>
        <span class="sheet-title">QR-код чека</span>
        <span class="link-placeholder" />
      </header>

      <div class={`scanner-view is-${camera}`}>
        <video ref={video} muted playsInline aria-hidden="true" />
        {camera === 'on' && <div class="scanner-frame" aria-hidden="true" />}
        {camera === 'starting' && <div class="scanner-note">Включаю камеру…</div>}
        {camera === 'off' && (
          <div class="scanner-note">
            <IconQr size={40} />
            <span>Камера недоступна</span>
          </div>
        )}
      </div>

      <p class={`scanner-message ${message && camera === 'on' ? 'is-warning' : ''}`} role="status" data-testid="scanner-message">
        {message ?? 'Наведи камеру на QR-код внизу чека — сумма и дата подставятся сами.'}
      </p>

      <button class="btn btn-plain" disabled={busy} onClick={() => fileInput.current?.click()}>
        {busy ? 'Ищу QR на фото…' : 'Выбрать фото чека'}
      </button>
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={() => void scanPhoto()} data-testid="receipt-photo" />
    </div>
  );
}
