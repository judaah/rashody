import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleSync, memoryStore, MAX_DATA } from '../sync-server/core';
import { handler, objectStorage } from '../sync-server/yandex';

const PAIR = 'pairAAAAAAAAAAAAAAAAAA';
const ME = 'deviceMeMeMeMeMeMe';
const PARTNER = 'devicePartnerPartner';
const AUTH = 'a'.repeat(43);
const req = (extra: Record<string, unknown>) => ({ pair: PAIR, auth: AUTH, ...extra });

describe('посредник', () => {
  it('обмен: каждый видит только снимок другого', async () => {
    const store = memoryStore();
    expect((await handleSync(store, req({ op: 'push', device: ME, data: 'шифр-мой' }))).status).toBe(200);
    // партнёр ещё не подключился — у меня пусто
    expect((await handleSync(store, req({ op: 'pull', device: ME }))).body).toEqual({ devices: [] });

    await handleSync(store, req({ op: 'push', device: PARTNER, data: 'шифр-партнёра' }));
    const mine = await handleSync(store, req({ op: 'pull', device: ME }));
    expect(mine.body.devices).toMatchObject([{ device: PARTNER, data: 'шифр-партнёра' }]);
    const theirs = await handleSync(store, req({ op: 'pull', device: PARTNER }));
    expect(theirs.body.devices).toMatchObject([{ device: ME, data: 'шифр-мой' }]);
  });

  it('уже полученный снимок не пересылается', async () => {
    const store = memoryStore();
    await handleSync(store, req({ op: 'push', device: PARTNER, data: 'x' }));
    const first = (await handleSync(store, req({ op: 'pull', device: ME }))).body.devices as Array<{ etag: string }>;
    const again = await handleSync(store, req({ op: 'pull', device: ME, known: { [PARTNER]: first[0].etag } }));
    expect(again.body.devices).toMatchObject([{ device: PARTNER, unchanged: true }]);
    expect((again.body.devices as Array<Record<string, unknown>>)[0].data).toBeUndefined();
  });

  it('метка версии берётся из списка, даже если у самого объекта она записана иначе', async () => {
    const inner = memoryStore();
    // как у Object Storage: в объекте ETag в одном виде, в списке — в другом
    const store = { ...inner, get: async (k: string) => {
      const b = await inner.get(k);
      return b ? { ...b, etag: `W/${b.etag}` } : null;
    } };
    await handleSync(store, req({ op: 'push', device: PARTNER, data: 'x' }));
    const first = (await handleSync(store, req({ op: 'pull', device: ME }))).body.devices as Array<{ etag: string }>;
    const again = await handleSync(store, req({ op: 'pull', device: ME, known: { [PARTNER]: first[0].etag } }));
    expect(again.body.devices).toMatchObject([{ unchanged: true }]);
  });

  it('чужой токен не читает и не пишет', async () => {
    const store = memoryStore();
    await handleSync(store, req({ op: 'push', device: ME, data: 'x' }));
    const stranger = { pair: PAIR, auth: 'b'.repeat(43) };
    expect((await handleSync(store, { ...stranger, op: 'pull', device: PARTNER })).status).toBe(403);
    expect((await handleSync(store, { ...stranger, op: 'push', device: PARTNER, data: 'мусор' })).status).toBe(403);
    expect((await handleSync(store, req({ op: 'pull', device: PARTNER }))).body.devices).toMatchObject([{ data: 'x' }]);
  });

  it('хранится только отпечаток токена, а не сам токен', async () => {
    const store = memoryStore();
    await handleSync(store, req({ op: 'push', device: ME, data: 'x' }));
    const saved = await store.get(`pairs/${PAIR}/auth`);
    expect(saved?.body).toMatch(/^[0-9a-f]{64}$/);
    expect(saved?.body).not.toContain(AUTH);
  });

  it('выход: свой снимок удаляется, последний вышедший удаляет пару', async () => {
    const store = memoryStore();
    await handleSync(store, req({ op: 'push', device: ME, data: 'x' }));
    await handleSync(store, req({ op: 'push', device: PARTNER, data: 'y' }));
    await handleSync(store, req({ op: 'leave', device: ME }));
    expect((await handleSync(store, req({ op: 'pull', device: PARTNER }))).body.devices).toEqual([]);
    expect(store.size()).toBe(2); // снимок партнёра + отпечаток токена
    await handleSync(store, req({ op: 'leave', device: PARTNER }));
    expect(store.size()).toBe(0);
  });

  it.each([
    [null, 400],
    [{ op: 'hack', device: ME, pair: PAIR, auth: AUTH }, 400],
    [{ op: 'pull', device: 'короткий', pair: PAIR, auth: AUTH }, 400],
    [{ op: 'pull', device: ME, pair: '../../etc', auth: AUTH }, 400],
    [{ op: 'pull', device: ME, pair: PAIR, auth: 'x' }, 400],
    [{ op: 'push', device: ME, pair: PAIR, auth: AUTH }, 400],
    [{ op: 'push', device: ME, pair: PAIR, auth: AUTH, data: 'x'.repeat(MAX_DATA + 1) }, 413],
  ])('отказ на кривой запрос %#', async (input, status) => {
    expect((await handleSync(memoryStore(), input)).status).toBe(status);
  });
});

describe('Yandex Cloud: Object Storage и функция', () => {
  /** Подменный Object Storage: проверяет токен и отвечает как настоящий S3 API. */
  function fakeStorage() {
    const objects = new Map<string, { body: string; etag: string; at: string }>();
    let n = 0;
    const calls: string[] = [];
    const impl = async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${u.pathname}${u.search}`);
      if ((init?.headers as Record<string, string>)?.Authorization !== 'Bearer iam-token') return new Response('denied', { status: 403 });
      const key = decodeURIComponent(u.pathname.replace(/^\/bucket\/?/, ''));
      if (u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') ?? '';
        const items = [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>${v.at}</LastModified><ETag>&quot;${v.etag}&quot;</ETag></Contents>`);
        return new Response(`<?xml version="1.0"?><ListBucketResult>${items.join('')}</ListBucketResult>`, { status: 200 });
      }
      if (method === 'PUT') {
        const etag = `e${++n}`;
        objects.set(key, { body: String(init?.body), etag, at: new Date(Date.UTC(2026, 9, 26, 10, n)).toISOString() });
        return new Response('', { status: 200, headers: { ETag: `"${etag}"` } });
      }
      if (method === 'DELETE') {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const obj = objects.get(key);
      if (!obj) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      return new Response(obj.body, { status: 200, headers: { ETag: `"${obj.etag}"`, 'Last-Modified': new Date(obj.at).toUTCString() } });
    };
    return { impl: impl as typeof fetch, calls, objects };
  }

  it('get/put/list/delete через S3 API с IAM-токеном', async () => {
    const fake = fakeStorage();
    const store = objectStorage('bucket', 'iam-token', fake.impl);
    expect(await store.get('pairs/p/devices/a')).toBeNull();
    const { etag } = await store.put('pairs/p/devices/a', 'шифр');
    expect(etag).toBe('"e1"');
    expect(await store.get('pairs/p/devices/a')).toMatchObject({ body: 'шифр', etag: '"e1"' });
    expect(await store.list('pairs/p/devices/')).toMatchObject([{ key: 'pairs/p/devices/a', etag: '"e1"' }]);
    await store.delete('pairs/p/devices/a');
    expect(await store.list('pairs/p/')).toEqual([]);
    await expect(objectStorage('bucket', 'чужой', fake.impl).get('x')).rejects.toThrow('403');
  });

  describe('функция', () => {
    const env = { ...process.env };
    let fake: ReturnType<typeof fakeStorage>;
    beforeEach(() => {
      process.env.BUCKET = 'bucket';
      process.env.ALLOWED_ORIGINS = 'https://judaah.github.io,http://localhost:8681';
      fake = fakeStorage();
      globalThis.fetch = fake.impl;
    });
    afterEach(() => {
      process.env = { ...env };
    });
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    const call = (body: unknown, extra: Record<string, unknown> = {}) =>
      handler(
        { httpMethod: 'POST', headers: { Origin: 'https://judaah.github.io' }, body: JSON.stringify(body), isBase64Encoded: false, ...extra },
        { token: { access_token: 'iam-token' } },
      );

    it('обмен через функцию и CORS только для приложения', async () => {
      const pushed = await call(req({ op: 'push', device: ME, data: 'шифр' }));
      expect(pushed.statusCode).toBe(200);
      expect(pushed.headers['Access-Control-Allow-Origin']).toBe('https://judaah.github.io');
      const pulled = await call(req({ op: 'pull', device: PARTNER }));
      expect(JSON.parse(pulled.body).devices).toMatchObject([{ device: ME, data: 'шифр' }]);
    });

    it('тело в base64 тоже понимает', async () => {
      const body = Buffer.from(JSON.stringify(req({ op: 'pull', device: ME }))).toString('base64');
      const res = await call(null, { body, isBase64Encoded: true });
      expect(res.statusCode).toBe(200);
    });

    it('чужой сайт, не POST, кривой JSON', async () => {
      expect((await call(req({ op: 'pull', device: ME }), { headers: { Origin: 'https://evil.example' } })).statusCode).toBe(403);
      expect((await call(null, { httpMethod: 'GET' })).statusCode).toBe(405);
      expect((await call(null, { body: '{не json' })).statusCode).toBe(400);
      const pre = await call(null, { httpMethod: 'OPTIONS' });
      expect(pre.statusCode).toBe(204);
    });

    it('сбой хранилища — 502, а не падение функции', async () => {
      globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
      expect((await call(req({ op: 'pull', device: ME }))).statusCode).toBe(502);
    });
  });
});
