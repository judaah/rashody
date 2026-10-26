import { parseReceiptQr, type Receipt } from '../lib/receipt';
import { QrScanSheet } from './QrScanSheet';

const TEXT = {
  title: 'QR-код чека',
  hint: 'Наведи камеру на QR-код внизу чека — сумма и дата подставятся сами.',
  wrongCode: 'Это не QR кассового чека — наведи на код внизу чека',
  photoButton: 'Выбрать фото чека',
  photoAction: 'выбери фото чека',
};

export function ReceiptScanner({ onResult, onClose }: { onResult: (r: Receipt) => void; onClose: () => void }) {
  return <QrScanSheet text={TEXT} parse={parseReceiptQr} onResult={onResult} onClose={onClose} />;
}
