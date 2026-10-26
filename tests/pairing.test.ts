import { describe, expect, it } from 'vitest';
import { authToken, decryptJson, encryptJson, fromB64url, newDeviceId, newPair, pairCode, parsePairCode, toB64url } from '../src/lib/pairing';
import { buildSnapshot, readSnapshot } from '../src/lib/snapshot';
import { DEFAULT_CATEGORIES } from '../src/db/seed';
import type { Expense } from '../src/db/db';

describe('код пары', () => {
  it('нового ключа хватает: 128 бит номера, 256 бит ключа', () => {
    const p = newPair();
    expect(fromB64url(p.pairId)).toHaveLength(16);
    expect(fromB64url(p.key)).toHaveLength(32);
    expect(newPair()).not.toEqual(p);
    expect(fromB64url(newDeviceId())).toHaveLength(16);
  });

  it('код читается из QR и из сообщения с переносами', () => {
    const p = newPair();
    const code = pairCode(p);
    expect(parsePairCode(code)).toEqual(p);
    expect(parsePairCode(`  ${code.slice(0, 30)}\n${code.slice(30)} `)).toEqual(p);
    expect(parsePairCode('rsh1.короткий.код')).toBeNull();
    expect(parsePairCode('t=20261026T1530&s=10&fn=1&i=2&fp=3')).toBeNull(); // QR чека — не код пары
  });

  it('base64url туда-обратно', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromB64url(toB64url(bytes))).toEqual(bytes);
    expect(toB64url(bytes)).not.toMatch(/[+/=]/);
  });
});

describe('шифрование снимка', () => {
  const big = { text: 'Пятёрочка'.repeat(500), n: [1, 2, 3] };

  it('туда-обратно, а снаружи — только шифр, сжатый', async () => {
    const p = newPair();
    const cipher = await encryptJson(big, p);
    expect(cipher.startsWith('v1.')).toBe(true);
    expect(cipher).not.toContain('Пятёрочка');
    expect(cipher.length).toBeLessThan(JSON.stringify(big).length / 5);
    expect(await decryptJson(cipher, p)).toEqual(big);
  });

  it('один и тот же снимок каждый раз шифруется по-разному', async () => {
    const p = newPair();
    expect(await encryptJson(big, p)).not.toBe(await encryptJson(big, p));
  });

  it('чужой ключ, чужая пара и испорченный шифр не проходят', async () => {
    const p = newPair();
    const cipher = await encryptJson(big, p);
    await expect(decryptJson(cipher, { ...p, key: newPair().key })).rejects.toThrow();
    await expect(decryptJson(cipher, { ...p, pairId: newPair().pairId })).rejects.toThrow();
    const [v, iv, data] = cipher.split('.');
    const flipped = data.slice(0, 10) + (data[10] === 'A' ? 'B' : 'A') + data.slice(11);
    await expect(decryptJson(`${v}.${iv}.${flipped}`, p)).rejects.toThrow();
    await expect(decryptJson('мусор', p)).rejects.toThrow('формат');
  });

  it('токен для посредника стабилен, разный у разных пар и не похож на ключ', async () => {
    const p = newPair();
    const token = await authToken(p.key);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await authToken(p.key)).toBe(token);
    expect(await authToken(newPair().key)).not.toBe(token);
    expect(token).not.toBe(p.key);
  });
});

describe('снимок', () => {
  const exp = (id: string, extra: Partial<Expense> = {}): Expense => ({
    id,
    amount: 25000,
    currency: 'RUB',
    amountRub: 25000,
    rate: 1,
    categoryId: 'cafe',
    date: '2026-10-26',
    note: 'Кофе',
    source: 'import',
    externalId: 'imp:secret',
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  });

  it('порядок стабилен, ключи выписки не уходят партнёру', () => {
    const a = buildSnapshot(' Дима ', DEFAULT_CATEGORIES, [exp('b'), exp('a')]);
    const b = buildSnapshot('Дима', [...DEFAULT_CATEGORIES].reverse(), [exp('a'), exp('b')]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.name).toBe('Дима');
    expect(a.expenses.map((e) => e.id)).toEqual(['a', 'b']);
    expect(JSON.stringify(a)).not.toContain('imp:secret');
  });

  it('входящий снимок: битые записи выбрасываются, недостающие поля дополняются', () => {
    const snap = readSnapshot({
      v: 1,
      name: 'Аня',
      categories: [...DEFAULT_CATEGORIES, { id: 'x' }],
      expenses: [exp('ok'), { id: 'bad', amount: 'много' }, { ...exp('old'), note: undefined, source: undefined }],
    });
    expect(snap.categories).toHaveLength(DEFAULT_CATEGORIES.length);
    expect(snap.expenses.map((e) => e.id)).toEqual(['ok', 'old']);
    expect(snap.expenses[1]).toMatchObject({ note: '', source: 'manual' });
    expect(() => readSnapshot({ v: 2 })).toThrow('неизвестном формате');
  });
});
