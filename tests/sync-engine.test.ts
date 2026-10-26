import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RashodyDB } from '../src/db/db';
import { handleSync, memoryStore } from '../sync-server/core';
import { getPairing, getPartner, joinPairing, leavePairing, setMyName, startPairing, syncOnce, SyncError, type Transport } from '../src/db/sync';
import type { Expense } from '../src/db/db';

// Два «телефона» — две отдельные базы, общий посредник в памяти.
let me: RashodyDB;
let partner: RashodyDB;
let store: ReturnType<typeof memoryStore>;
let requests: Array<Record<string, unknown>>;
let relay: Transport;

const expense = (id: string, amount: number, extra: Partial<Expense> = {}): Expense => ({
  id,
  amount,
  currency: 'RUB',
  amountRub: amount,
  rate: 1,
  categoryId: 'groceries',
  date: '2026-10-26',
  note: '',
  source: 'manual',
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

beforeEach(async () => {
  me = new RashodyDB(`me-${Math.random()}`);
  partner = new RashodyDB(`partner-${Math.random()}`);
  await Promise.all([me.open(), partner.open()]);
  store = memoryStore();
  requests = [];
  relay = async (request) => {
    requests.push(request);
    return handleSync(store, JSON.parse(JSON.stringify(request)));
  };
  await setMyName('Дима', me);
  await setMyName('Аня', partner);
});

afterEach(async () => {
  await Promise.all([me.delete(), partner.delete()]);
});

const pair = async () => {
  const { code } = await startPairing(relay, me);
  await joinPairing(code, relay, partner);
  return code;
};

describe('обмен с партнёром', () => {
  it('подключение: партнёр сразу видит мои траты, я его — после обмена', async () => {
    await me.expenses.add(expense('m1', 125000, { note: 'Пятёрочка' }));
    await partner.expenses.add(expense('p1', 45000, { categoryId: 'cafe' }));
    const { code, state } = await startPairing(relay, me);
    expect(code).toMatch(/^rsh1\./);
    expect(state?.status).toBe('waiting'); // партнёр ещё не подключился

    const joined = await joinPairing(code, relay, partner);
    expect(joined).toMatchObject({ status: 'ok', partner: { name: 'Дима' } });
    expect(await partner.partnerExpenses.toArray()).toMatchObject([{ id: 'm1', amount: 125000, note: 'Пятёрочка' }]);

    const mine = await syncOnce(relay, me);
    expect(mine).toMatchObject({ status: 'ok', partner: { name: 'Аня' } });
    expect((await me.partnerExpenses.toArray()).map((e) => e.id)).toEqual(['p1']);
    expect(await me.partnerCategories.count()).toBeGreaterThan(0);
  });

  it('новая трата, правка и удаление доезжают; без изменений ничего не пересылается', async () => {
    await pair();
    await me.expenses.add(expense('m1', 100));
    await syncOnce(relay, me);
    await syncOnce(relay, partner);
    expect((await partner.partnerExpenses.toArray()).map((e) => e.amount)).toEqual([100]);

    await me.expenses.update('m1', { amount: 300, amountRub: 300 });
    await me.expenses.add(expense('m2', 50));
    await syncOnce(relay, me);
    await syncOnce(relay, partner);
    expect((await partner.partnerExpenses.toArray()).map((e) => [e.id, e.amount])).toEqual([
      ['m1', 300],
      ['m2', 50],
    ]);

    await me.expenses.delete('m1');
    await syncOnce(relay, me);
    await syncOnce(relay, partner);
    expect((await partner.partnerExpenses.toArray()).map((e) => e.id)).toEqual(['m2']);

    requests = [];
    await syncOnce(relay, me);
    await syncOnce(relay, partner);
    expect(requests.map((r) => r.op)).toEqual(['pull', 'pull']); // ничего нового — только проверки
  });

  it('у посредника лежит только шифр', async () => {
    await me.expenses.add(expense('m1', 100, { note: 'Секретная аптека' }));
    await pair();
    const pushes = requests.filter((r) => r.op === 'push').map((r) => String(r.data));
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.join()).not.toContain('Секретная');
    expect(pushes.join()).not.toContain('Дима');
    const pairing = await getPairing(me);
    expect(JSON.stringify(requests)).not.toContain(pairing!.key);
  });

  it('отключение: снимок уходит от посредника, у партнёра пропадают мои траты', async () => {
    await me.expenses.add(expense('m1', 100));
    await pair();
    await syncOnce(relay, me);
    await leavePairing(relay, me);
    expect(await getPairing(me)).toBeNull();
    expect(await me.partnerExpenses.count()).toBe(0);
    expect(await syncOnce(relay, me)).toEqual({ status: 'off', partner: null });

    expect(await syncOnce(relay, partner)).toEqual({ status: 'waiting', partner: null });
    expect(await partner.partnerExpenses.count()).toBe(0);
    expect(await getPartner(partner)).toBeNull();
  });

  it('кривой код и чужая пара', async () => {
    await expect(joinPairing('привет', relay, partner)).rejects.toThrow(SyncError);
    const code = await pair();
    // подмена шифра у посредника — партнёр получает понятную ошибку, а не падение
    const pairing = await getPairing(me);
    await store.put(`pairs/${pairing!.pairId}/devices/${pairing!.deviceId}`, 'v1.AAAA.BBBB');
    await expect(syncOnce(relay, partner)).rejects.toThrow('расшифровать');
    expect(code).toBeTruthy();
  });

  it('нет сети при создании пары — код всё равно выдаётся', async () => {
    const offline: Transport = async () => {
      throw new TypeError('Failed to fetch');
    };
    const { code, state } = await startPairing(offline, me);
    expect(code).toMatch(/^rsh1\./);
    expect(state).toBeNull();
    await expect(syncOnce(offline, me)).rejects.toThrow('Failed to fetch');
  });

  it('два одновременных обмена сливаются в один — снимок уходит один раз', async () => {
    await pair();
    await me.expenses.add(expense('m1', 100));
    requests = [];
    const [a, b] = await Promise.all([syncOnce(relay, me), syncOnce(relay, me)]);
    expect(a).toBe(b);
    expect(requests.map((r) => r.op)).toEqual(['push', 'pull']);
  });

  it('повторное подключение тем же кодом сохраняет номер телефона в паре', async () => {
    const code = await pair();
    const before = await getPairing(partner);
    await joinPairing(code, relay, partner);
    expect((await getPairing(partner))!.deviceId).toBe(before!.deviceId);
  });
});
