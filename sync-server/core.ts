// Посредник обмена тратами между двумя телефонами. Ничего не знает о тратах:
// хранит по одному зашифрованному снимку на устройство и отдаёт снимки партнёра.
// Не привязан к облаку — хранилище передаётся снаружи (BlobStore).

export interface StoredBlob {
  body: string;
  etag: string;
  updatedAt: number;
}

export interface BlobMeta {
  key: string;
  etag: string;
  updatedAt: number;
}

export interface BlobStore {
  get(key: string): Promise<StoredBlob | null>;
  put(key: string, body: string): Promise<{ etag: string }>;
  list(prefix: string): Promise<BlobMeta[]>;
  delete(key: string): Promise<void>;
}

export interface SyncResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Снимок до 3 МБ — это примерно 15 лет трат одного человека. */
export const MAX_DATA = 3_000_000;
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const AUTH = /^[A-Za-z0-9_-]{32,128}$/;

const fail = (status: number, error: string): SyncResponse => ({ status, body: { error } });

async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const authKey = (pair: string) => `pairs/${pair}/auth`;
const devicesPrefix = (pair: string) => `pairs/${pair}/devices/`;
const deviceKey = (pair: string, device: string) => `${devicesPrefix(pair)}${device}`;

/**
 * Токен пары запоминается при первом обращении (номер пары — 128 случайных бит,
 * угадать нельзя). Дальше без того же токена пара не читается и не пишется.
 * Храним только отпечаток токена, а сам токен выводится из ключа на телефонах.
 */
async function checkAuth(store: BlobStore, pair: string, auth: string): Promise<boolean> {
  const expected = await store.get(authKey(pair));
  const actual = await sha256hex(auth);
  if (!expected) {
    await store.put(authKey(pair), actual);
    return true;
  }
  return expected.body === actual;
}

export async function handleSync(store: BlobStore, input: unknown): Promise<SyncResponse> {
  const req = input as Record<string, unknown> | null;
  if (!req || typeof req !== 'object') return fail(400, 'bad request');
  const { op, pair, device, auth } = req;
  if (op !== 'push' && op !== 'pull' && op !== 'leave') return fail(400, 'unknown op');
  if (typeof pair !== 'string' || !ID.test(pair)) return fail(400, 'bad pair');
  if (typeof device !== 'string' || !ID.test(device)) return fail(400, 'bad device');
  if (typeof auth !== 'string' || !AUTH.test(auth)) return fail(400, 'bad auth');
  if (op === 'push') {
    if (typeof req.data !== 'string' || req.data.length === 0) return fail(400, 'no data');
    if (req.data.length > MAX_DATA) return fail(413, 'too large');
  }
  if (!(await checkAuth(store, pair, auth))) return fail(403, 'forbidden');

  if (op === 'push') {
    const { etag } = await store.put(deviceKey(pair, device), req.data as string);
    return { status: 200, body: { ok: true, etag } };
  }

  if (op === 'pull') {
    // known — какие версии снимков у телефона уже есть: их не пересылаем заново
    const known = (req.known && typeof req.known === 'object' ? req.known : {}) as Record<string, unknown>;
    const metas = (await store.list(devicesPrefix(pair))).filter((m) => m.key !== deviceKey(pair, device));
    const devices = [];
    for (const m of metas) {
      const id = m.key.slice(devicesPrefix(pair).length);
      if (known[id] === m.etag) {
        devices.push({ device: id, etag: m.etag, updatedAt: m.updatedAt, unchanged: true });
        continue;
      }
      const blob = await store.get(m.key);
      // Метку версии отдаём ту же, что в списке: Object Storage пишет её в списке и в самом
      // объекте по-разному, а сравнивать в следующий раз будем именно со списком.
      if (blob) devices.push({ device: id, etag: m.etag, updatedAt: m.updatedAt, data: blob.body });
    }
    return { status: 200, body: { devices } };
  }

  // leave: убираем свой снимок; если в паре больше никого — и саму пару
  await store.delete(deviceKey(pair, device));
  if ((await store.list(devicesPrefix(pair))).length === 0) await store.delete(authKey(pair));
  return { status: 200, body: { ok: true } };
}

/** Хранилище в памяти — для тестов и локальной проверки. */
export function memoryStore(): BlobStore & { size(): number } {
  const data = new Map<string, StoredBlob>();
  let version = 0;
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, body) {
      const etag = `"v${++version}"`;
      data.set(key, { body, etag, updatedAt: Date.now() });
      return { etag };
    },
    async list(prefix) {
      return [...data.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, etag: v.etag, updatedAt: v.updatedAt }));
    },
    async delete(key) {
      data.delete(key);
    },
    size: () => data.size,
  };
}
