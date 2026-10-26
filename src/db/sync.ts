// Обмен тратами с партнёром через посредника. Каждый телефон — единственный автор своих трат:
// отправляем свой снимок целиком, забираем снимок партнёра целиком. Слияний и конфликтов нет.

import { db as defaultDb, RashodyDB, SETTING_PAIRING, SETTING_PARTNER, SETTING_PUSH_HASH } from './db';
import { authToken, decryptJson, encryptJson, newDeviceId, newPair, pairCode, parsePairCode, sha256, type PairSecret } from '../lib/pairing';
import { buildSnapshot, readSnapshot } from '../lib/snapshot';

export const SETTING_MY_NAME = 'myName';

export interface Pairing extends PairSecret {
  deviceId: string;
  createdAt: number;
}

export interface PartnerInfo {
  device: string;
  name: string;
  etag: string;
  /** Когда партнёр последний раз менял свои траты (время посредника). */
  updatedAt: number;
  /** Когда мы последний раз успешно сходили к посреднику. */
  syncedAt: number;
}

export interface SyncState {
  /** off — не подключены; waiting — пара есть, партнёр ещё не подключился (или отключился). */
  status: 'off' | 'waiting' | 'ok';
  partner: PartnerInfo | null;
}

export interface RelayResponse {
  status: number;
  body: Record<string, unknown>;
}
export type Transport = (request: Record<string, unknown>) => Promise<RelayResponse>;

export class SyncError extends Error {}

/** «Простой» POST с text/plain: браузер не шлёт предварительный OPTIONS, посреднику проще. */
export function httpTransport(url: string): Transport {
  return async (request) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(request) });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // посредник ответил не JSON — разберёмся по статусу
    }
    return { status: res.status, body };
  };
}

async function setting<T>(d: RashodyDB, key: string): Promise<T | null> {
  const row = await d.settings.get(key);
  return row ? (row.value as T) : null;
}

export const getPairing = (d: RashodyDB = defaultDb) => setting<Pairing>(d, SETTING_PAIRING);
export const getPartner = (d: RashodyDB = defaultDb) => setting<PartnerInfo>(d, SETTING_PARTNER);
export const getMyName = async (d: RashodyDB = defaultDb) => (await setting<string>(d, SETTING_MY_NAME)) ?? '';

export async function setMyName(name: string, d: RashodyDB = defaultDb): Promise<void> {
  await d.settings.put({ key: SETTING_MY_NAME, value: name.trim().slice(0, 40) });
}

function check(res: RelayResponse): void {
  if (res.status === 403) throw new SyncError('Посредник не узнал пару — отключитесь и подключитесь заново');
  if (res.status >= 400) throw new SyncError(`Посредник ответил ошибкой ${res.status}`);
}

async function clearPartner(d: RashodyDB): Promise<void> {
  await d.transaction('rw', [d.partnerExpenses, d.partnerCategories, d.settings], async () => {
    await d.partnerExpenses.clear();
    await d.partnerCategories.clear();
    await d.settings.delete(SETTING_PARTNER);
  });
}

// Обмен на одной базе идёт не больше одного за раз: создание пары и фоновый таймер
// иначе отправили бы один и тот же снимок дважды.
const running = new WeakMap<RashodyDB, Promise<SyncState>>();

/** Один обмен: отправить своё, если изменилось, и забрать снимок партнёра, если у него новая версия. */
export function syncOnce(transport: Transport, d: RashodyDB = defaultDb): Promise<SyncState> {
  const current = running.get(d);
  if (current) return current;
  const next = exchange(transport, d).finally(() => running.delete(d));
  running.set(d, next);
  return next;
}

async function exchange(transport: Transport, d: RashodyDB): Promise<SyncState> {
  const pairing = await getPairing(d);
  if (!pairing) return { status: 'off', partner: null };
  const base = { pair: pairing.pairId, device: pairing.deviceId, auth: await authToken(pairing.key) };

  const snapshot = buildSnapshot(await getMyName(d), await d.categories.toArray(), await d.expenses.toArray());
  const hash = await sha256(JSON.stringify(snapshot));
  if (hash !== (await setting<string>(d, SETTING_PUSH_HASH))) {
    check(await transport({ ...base, op: 'push', data: await encryptJson(snapshot, pairing) }));
    await d.settings.put({ key: SETTING_PUSH_HASH, value: hash });
  }

  const partner = await getPartner(d);
  const res = await transport({ ...base, op: 'pull', known: partner ? { [partner.device]: partner.etag } : {} });
  check(res);
  const devices = ((res.body.devices ?? []) as Array<{ device: string; etag: string; updatedAt: number; data?: string; unchanged?: boolean }>).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const latest = devices[0];
  if (!latest) {
    // партнёр отключился (или ещё не подключался) — его траты у нас больше не показываем
    if (partner) await clearPartner(d);
    return { status: 'waiting', partner: null };
  }
  const now = Date.now();
  if (latest.unchanged && partner && latest.device === partner.device) {
    const info = { ...partner, syncedAt: now };
    await d.settings.put({ key: SETTING_PARTNER, value: info });
    return { status: 'ok', partner: info };
  }
  if (!latest.data) throw new SyncError('Посредник не прислал траты партнёра');

  let snap;
  try {
    snap = readSnapshot(await decryptJson(latest.data, pairing));
  } catch (err) {
    if (err instanceof Error && err.message.includes('формате')) throw new SyncError(err.message);
    throw new SyncError('Не получилось расшифровать траты партнёра — подключитесь заново');
  }
  const info: PartnerInfo = { device: latest.device, name: snap.name, etag: latest.etag, updatedAt: latest.updatedAt, syncedAt: now };
  await d.transaction('rw', [d.partnerExpenses, d.partnerCategories, d.settings], async () => {
    await d.partnerExpenses.clear();
    await d.partnerCategories.clear();
    await d.partnerExpenses.bulkPut(snap.expenses);
    await d.partnerCategories.bulkPut(snap.categories);
    await d.settings.put({ key: SETTING_PARTNER, value: info });
  });
  return { status: 'ok', partner: info };
}

/** Создать пару (или вернуть код уже созданной) и сразу выложить свои траты. */
export async function startPairing(transport: Transport, d: RashodyDB = defaultDb): Promise<{ code: string; state: SyncState | null }> {
  let pairing = await getPairing(d);
  if (!pairing) {
    pairing = { ...newPair(), deviceId: newDeviceId(), createdAt: Date.now() };
    await d.settings.put({ key: SETTING_PAIRING, value: pairing });
    await d.settings.delete(SETTING_PUSH_HASH);
  }
  // Нет сети — не беда: код уже есть, траты уйдут при следующем обмене.
  const state = await syncOnce(transport, d).catch(() => null);
  return { code: pairCode(pairing), state };
}

/** Подключиться к партнёру по коду из его QR. */
export async function joinPairing(code: string, transport: Transport, d: RashodyDB = defaultDb): Promise<SyncState> {
  const secret = parsePairCode(code);
  if (!secret) throw new SyncError('Это не код пары. Попроси партнёра открыть «Настройки → Партнёр» и показать QR ещё раз.');
  const existing = await getPairing(d);
  if (existing && existing.pairId !== secret.pairId) await leavePairing(transport, d);
  const pairing: Pairing = {
    ...secret,
    deviceId: existing?.pairId === secret.pairId ? existing.deviceId : newDeviceId(),
    createdAt: Date.now(),
  };
  await d.settings.put({ key: SETTING_PAIRING, value: pairing });
  await d.settings.delete(SETTING_PUSH_HASH);
  return syncOnce(transport, d);
}

/** Отключиться: убрать свой снимок у посредника и траты партнёра у себя. */
export async function leavePairing(transport: Transport, d: RashodyDB = defaultDb): Promise<void> {
  const pairing = await getPairing(d);
  if (pairing) {
    try {
      await transport({ op: 'leave', pair: pairing.pairId, device: pairing.deviceId, auth: await authToken(pairing.key) });
    } catch {
      // нет сети — локально всё равно отключаемся; снимок у посредника перестанет обновляться
    }
  }
  await clearPartner(d);
  await d.settings.bulkDelete([SETTING_PAIRING, SETTING_PUSH_HASH]);
}
