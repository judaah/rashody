// Тестовые картинки для проверки сканера чеков в браузере.
//
//   node tools/qr-test-images.mjs dist/__test__
//   python3 tools/qr-test-photos.py dist/__test__
//
// Первая команда кладёт чистые QR (покупка, возврат, не-чек), вторая делает из QR покупки
// «фото чека» разной сложности. Папка dist/__test__ отдаётся `npm run preview` по адресу
// /__test__/…; картинки подаются в <input data-testid="qr-photo"> через DataTransfer.
// Следующая сборка папку стирает.

import { mkdirSync } from 'node:fs';
import QRCode from 'qrcode';

const outDir = process.argv[2] ?? 'dist/__test__';
mkdirSync(outDir, { recursive: true });

const samples = {
  purchase: 't=20261025T1847&s=1342.50&fn=7380440700076549&i=41975&fp=2026064292&n=1',
  refund: 't=20261025T1902&s=299.00&fn=7380440700076549&i=41980&fp=3311992200&n=2',
  url: 'https://example.com/promo',
};

for (const [name, text] of Object.entries(samples)) {
  await QRCode.toFile(`${outDir}/${name}.png`, text, { errorCorrectionLevel: 'M', margin: 2, width: 260 });
  console.log(`${outDir}/${name}.png — ${text}`);
}
