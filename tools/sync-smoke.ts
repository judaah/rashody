// Второй «телефон» для проверки обмена с живым посредником — тем же кодом, что в приложении.
//
//   npx vite-node tools/sync-smoke.ts join <код пары> [имя]   — подключиться, записать тестовую трату
//   npx vite-node tools/sync-smoke.ts leave                     — отключиться и убрать свой снимок
//
// База — в памяти процесса (fake-indexeddb), состояние между запусками хранится в
// /tmp/rashody-sync-smoke.json. Адрес посредника — переменная SYNC_URL.

import 'fake-indexeddb/auto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { RashodyDB } from '../src/db/db';
import { joinPairing, leavePairing, setMyName, syncOnce, type Transport } from '../src/db/sync';
import { addDays, today } from '../src/lib/dates';

const STATE = '/tmp/rashody-sync-smoke.json';
const url = process.env.SYNC_URL;
if (!url) throw new Error('Задай SYNC_URL — адрес функции посредника');

// Браузер сам ставит Origin; здесь ставим его руками — посредник пускает только приложение.
const relay: Transport = async (request) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: 'https://judaah.github.io' },
    body: JSON.stringify(request),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

const d = new RashodyDB('smoke');
await d.open();
// состояние «телефона» между запусками: настройки и мои траты
if (existsSync(STATE)) {
  const saved = JSON.parse(readFileSync(STATE, 'utf8'));
  await d.settings.bulkPut(saved.settings);
  await d.expenses.bulkPut(saved.expenses);
}
const persist = async () =>
  writeFileSync(STATE, JSON.stringify({ settings: await d.settings.toArray(), expenses: await d.expenses.toArray() }));

const [cmd, code, name = 'Тест'] = process.argv.slice(2);
if (cmd === 'join') {
  await setMyName(name, d);
  await d.expenses.put({
    id: 'smoke-1',
    amount: 12300,
    currency: 'RUB',
    amountRub: 12300,
    rate: 1,
    categoryId: 'cafe',
    date: addDays(today(), 0),
    note: 'проверка обмена',
    source: 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const state = await joinPairing(code, relay, d);
  const again = await syncOnce(relay, d);
  console.log(`подключён: ${again.status}, партнёр «${state.partner?.name ?? '—'}», его трат получено: ${await d.partnerExpenses.count()}`);
  await persist();
} else if (cmd === 'leave') {
  await leavePairing(relay, d);
  if (existsSync(STATE)) unlinkSync(STATE);
  console.log('отключён, снимок у посредника убран');
} else {
  console.log('команды: join <код> [имя] | leave');
}
