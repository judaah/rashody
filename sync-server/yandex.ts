// Обёртка посредника для Yandex Cloud Functions: HTTP-запрос → handleSync,
// хранилище — Object Storage, доступ по IAM-токену сервисного аккаунта функции.
//
// Переменные окружения функции:
//   BUCKET           — бакет для снимков
//   ALLOWED_ORIGINS  — через запятую, откуда браузеру можно обращаться (https://judaah.github.io)

import { handleSync, type BlobStore } from './core';

interface HttpEvent {
  httpMethod?: string;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface Context {
  token?: { access_token?: string };
}

const STORAGE = 'https://storage.yandexcloud.net';

const decodeXml = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'");

/** Object Storage по S3 REST API без SDK: IAM-токен вместо подписи запросов. */
export function objectStorage(bucket: string, token: string, fetchImpl: typeof fetch = fetch): BlobStore {
  const url = (key: string) => `${STORAGE}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const auth = { Authorization: `Bearer ${token}` };
  const check = async (res: Response, what: string) => {
    if (!res.ok) throw new Error(`Object Storage ${what}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
  return {
    async get(key) {
      const res = await fetchImpl(url(key), { headers: auth });
      if (res.status === 404) return null;
      await check(res, 'get');
      return {
        body: await res.text(),
        etag: res.headers.get('ETag') ?? '',
        updatedAt: Date.parse(res.headers.get('Last-Modified') ?? '') || 0,
      };
    },
    async put(key, body) {
      const res = await fetchImpl(url(key), { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/plain' }, body });
      await check(res, 'put');
      return { etag: res.headers.get('ETag') ?? '' };
    },
    async list(prefix) {
      const res = await fetchImpl(`${STORAGE}/${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`, { headers: auth });
      await check(res, 'list');
      const xml = await res.text();
      return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, c]) => ({
        key: decodeXml(c.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? ''),
        etag: decodeXml(c.match(/<ETag>([\s\S]*?)<\/ETag>/)?.[1] ?? ''),
        updatedAt: Date.parse(c.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1] ?? '') || 0,
      }));
    },
    async delete(key) {
      const res = await fetchImpl(url(key), { method: 'DELETE', headers: auth });
      if (res.status !== 404) await check(res, 'delete');
    },
  };
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  // через запятую, точку с запятой или пробел: в yc --environment запятая разделяет сами переменные
  const allowed = (process.env.ALLOWED_ORIGINS ?? '').split(/[,;\s]+/).filter(Boolean);
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Точка входа Cloud Functions: index.handler */
export async function handler(event: HttpEvent, context: Context): Promise<HttpResult> {
  const headers = event.headers ?? {};
  const origin = headers.Origin ?? headers.origin;
  const cors = corsHeaders(origin);
  const reply = (statusCode: number, body: unknown): HttpResult => ({
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Телефон шлёт «простой» POST с text/plain — предварительного OPTIONS не бывает,
  // но на всякий случай отвечаем и на него.
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  if (!cors['Access-Control-Allow-Origin']) return reply(403, { error: 'origin not allowed' });

  const token = context.token?.access_token;
  const bucket = process.env.BUCKET;
  if (!token || !bucket) return reply(500, { error: 'function is not configured' });

  let input: unknown;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    input = JSON.parse(raw);
  } catch {
    return reply(400, { error: 'bad json' });
  }
  try {
    const res = await handleSync(objectStorage(bucket, token), input);
    return reply(res.status, res.body);
  } catch (err) {
    console.error(err);
    return reply(502, { error: 'storage error' });
  }
}
