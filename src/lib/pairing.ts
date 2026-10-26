// Пара «я + партнёр»: общий секрет, шифрование снимков и токен для посредника.
//
// Код пары (он же содержимое QR): rsh1.<номер пары>.<ключ> — 128 и 256 случайных бит.
// Из ключа через HKDF выводятся два независимых: AES-GCM для снимков и токен для
// посредника. Посредник видит только токен и по нему не может восстановить ключ шифрования.

export interface PairSecret {
  pairId: string;
  /** Общий ключ пары, base64url. Есть только на двух телефонах. */
  key: string;
}

const CODE_PREFIX = 'rsh1';
const CODE = /^rsh1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export function newPair(): PairSecret {
  return { pairId: toB64url(random(16)), key: toB64url(random(32)) };
}

export function newDeviceId(): string {
  return toB64url(random(16));
}

export function pairCode(p: PairSecret): string {
  return `${CODE_PREFIX}.${p.pairId}.${p.key}`;
}

/** Код из QR или из сообщения: пробелы и переносы, которые добавляют мессенджеры, игнорируем. */
export function parsePairCode(text: string): PairSecret | null {
  const m = text.replace(/\s+/g, '').match(CODE);
  return m ? { pairId: m[1], key: m[2] } : null;
}

// ---------- ключи ----------

const enc = new TextEncoder();

async function hkdfBase(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromB64url(key) as BufferSource, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

const hkdfParams = (info: string): HkdfParams => ({
  name: 'HKDF',
  hash: 'SHA-256',
  salt: enc.encode('rashody'),
  info: enc.encode(info),
});

async function encryptionKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(hkdfParams('rashody/snapshot/v1'), await hkdfBase(key), { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Токен для посредника — отдельная производная ключа. */
export async function authToken(key: string): Promise<string> {
  const bits = await crypto.subtle.deriveBits(hkdfParams('rashody/relay-auth/v1'), await hkdfBase(key), 256);
  return toB64url(new Uint8Array(bits));
}

// ---------- шифрование ----------

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * JSON → gzip → AES-GCM. Номер пары подмешан как дополнительные данные: снимок
 * из другой пары не расшифруется, даже если ключ совпал бы.
 */
export async function encryptJson(value: unknown, p: PairSecret): Promise<string> {
  const iv = random(12);
  const plain = await gzip(enc.encode(JSON.stringify(value)));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(p.pairId) },
    await encryptionKey(p.key),
    plain as BufferSource,
  );
  return `v1.${toB64url(iv)}.${toB64url(new Uint8Array(cipher))}`;
}

/** Бросает ошибку, если шифр испорчен, подменён или от другой пары. */
export async function decryptJson<T>(text: string, p: PairSecret): Promise<T> {
  const [version, iv, data] = text.split('.');
  if (version !== 'v1' || !iv || !data) throw new Error('Неизвестный формат снимка');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64url(iv) as BufferSource, additionalData: enc.encode(p.pairId) },
    await encryptionKey(p.key),
    fromB64url(data) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(await gunzip(new Uint8Array(plain)))) as T;
}

export async function sha256(text: string): Promise<string> {
  return toB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
}
