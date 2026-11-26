import type { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import type { Env } from '../../../config/env';
import { FakeSettings } from '../../../settings/settings.fake';
import type { ServiceTokens } from '../service-tokens';
import type { ClaimedDelivery, DeliveryStore } from './delivery-store';
import { DeliveryWorker } from './delivery-worker';
import type { RowUpdate } from './retry-rule';

// covers: spec 0029 AC-21 (the worker of child 0004: sends, versions, outcomes)

const now = new Date('2026-11-27T01:00:00Z');

function claimed(over: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    id: 'd1',
    kind: 'REPAIR_EVENT',
    payload: { eventId: 'd1', eventType: 'OPENED' },
    attempts: 1,
    firstAttemptAt: now,
    repairTicketId: 't1',
    ...over,
  };
}

function setup(rows: ClaimedDelivery[], answer: () => Promise<Response>) {
  const settled: { id: string; update: RowUpdate; version?: unknown }[] = [];
  const store = {
    claim: jest.fn(() => Promise.resolve(rows)),
    eventVersion: jest.fn(() => Promise.resolve(4)),
    settle: jest.fn(
      (id: string, update: RowUpdate, _at: Date, version?: unknown) => {
        settled.push({ id, update, version });
        return Promise.resolve();
      },
    ),
  };
  const client = {
    token: jest.fn(() => Promise.resolve('svc-token')),
    drop: jest.fn(),
  };
  const tokens = { for: jest.fn(() => client) };
  const fetchFn = jest.fn(answer);
  const config = {
    get: () => 'http://api-gateway:3000/',
  } as unknown as ConfigService<Env, true>;
  const worker = new DeliveryWorker(
    store as unknown as DeliveryStore,
    tokens as unknown as ServiceTokens,
    new FakeSettings(),
    config,
    fetchFn,
  );
  return { worker, store, client, tokens, fetchFn, settled };
}

const reply =
  (status: number, body = '') =>
  () =>
    Promise.resolve(new Response(body, { status }));

describe('DeliveryWorker.tick', () => {
  it('posts a repair event to VMMS through the gateway with a service token and the next version', async () => {
    const { worker, tokens, fetchFn, settled } = setup([claimed()], reply(202));
    await expect(worker.tick(() => now)).resolves.toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
    });
    expect(tokens.for).toHaveBeenCalledWith(
      'VMMS',
      'fleet.repair-status.write',
    );
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'http://api-gateway:3000/vmms/integrations/vrms/repair-events',
    );
    expect(init.headers).toMatchObject({ authorization: 'Bearer svc-token' });
    // Sent as stored, with eventVersion filled in at send time: one above VMMS's last
    expect(JSON.parse(init.body as string)).toEqual({
      eventId: 'd1',
      eventType: 'OPENED',
      eventVersion: 5,
    });
    expect(settled).toEqual([
      {
        id: 'd1',
        update: { status: 'SENT', lastStatusCode: 202 },
        version: {
          repairTicketId: 't1',
          eventVersion: 5,
          column: 'vmmsEventVersion',
        },
      },
    ]);
  });

  it('numbers a BMS repair update from BMS’s own counter, apart from VMMS’s', async () => {
    const row = claimed({
      kind: 'REPAIR_UPDATE',
      payload: { eventId: 'd1', repairStatus: 'OPEN' },
    });
    const { worker, store, tokens, fetchFn, settled } = setup(
      [row],
      reply(200),
    );
    await worker.tick(() => now);
    expect(store.eventVersion).toHaveBeenCalledWith('t1', 'bmsEventVersion');
    expect(tokens.for).toHaveBeenCalledWith('BMS', 'repair.update.write');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'http://api-gateway:3000/bms/integrations/vrms/repair-updates',
    );
    expect(JSON.parse(init.body as string)).toMatchObject({ eventVersion: 5 });
    expect(settled[0].version).toEqual({
      repairTicketId: 't1',
      eventVersion: 5,
      column: 'bmsEventVersion',
    });
  });

  it('sends an unversioned kind as stored, with its own scope', async () => {
    const row = claimed({
      kind: 'REFERRAL_REJECTED',
      repairTicketId: null,
      payload: { eventId: 'd1' },
    });
    const { worker, store, tokens, fetchFn, settled } = setup(
      [row],
      reply(202),
    );
    await worker.tick(() => now);
    expect(store.eventVersion).not.toHaveBeenCalled();
    expect(tokens.for).toHaveBeenCalledWith(
      'VMMS',
      'repair.referral-status.write',
    );
    expect(
      JSON.parse(
        (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body as string,
      ),
    ).toEqual({
      eventId: 'd1',
    });
    expect(settled[0].version).toBeUndefined();
  });

  it('schedules a retry on 503 and keeps the other system’s code', async () => {
    const { worker, settled } = setup(
      [claimed()],
      reply(503, '{"code":"SERVICE_UNAVAILABLE"}'),
    );
    await worker.tick(() => now);
    expect(settled[0].update).toEqual({
      status: 'PENDING',
      nextAttemptAt: new Date(now.getTime() + 30_000),
      lastStatusCode: 503,
      lastError: 'SERVICE_UNAVAILABLE',
    });
  });

  it('fails a 409 at once and reports it as failed', async () => {
    const { worker, settled } = setup(
      [claimed()],
      reply(409, '{"code":"EVENT_VERSION_CONFLICT"}'),
    );
    await expect(worker.tick(() => now)).resolves.toMatchObject({ failed: 1 });
    expect(settled[0].update).toMatchObject({
      status: 'FAILED',
      lastStatusCode: 409,
    });
  });

  it('drops the kept token on a 401, so the retry fetches a fresh one', async () => {
    const { worker, client, settled } = setup([claimed()], reply(401));
    await worker.tick(() => now);
    expect(client.drop).toHaveBeenCalled();
    expect(settled[0].update.status).toBe('PENDING');
  });

  it('counts a token failure and a network error as retryable, never sending without a token', async () => {
    const down = setup([claimed()], reply(202));
    down.client.token.mockRejectedValueOnce(
      new HttpException({ code: 'AUTH_UNAVAILABLE' }, 503),
    );
    await down.worker.tick(() => now);
    expect(down.fetchFn).not.toHaveBeenCalled();
    expect(down.settled[0].update).toMatchObject({
      status: 'PENDING',
      lastStatusCode: null,
      lastError: 'AUTH_UNAVAILABLE',
    });

    const refused = setup([claimed()], () =>
      Promise.reject(
        new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
      ),
    );
    await refused.worker.tick(() => now);
    expect(refused.settled[0].update).toMatchObject({
      status: 'PENDING',
      lastError: 'ECONNREFUSED',
    });
  });

  it('sends every claimed row, at most five at a time', async () => {
    let open = 0;
    let most = 0;
    const rows = Array.from({ length: 12 }, (_, i) =>
      claimed({ id: `d${i}`, repairTicketId: `t${i}` }),
    );
    const { worker, settled } = setup(rows, async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      return new Response('', { status: 202 });
    });
    await expect(worker.tick(() => now)).resolves.toEqual({
      claimed: 12,
      sent: 12,
      failed: 0,
    });
    expect(most).toBe(5);
    expect(settled.map((s) => s.id).sort()).toEqual(
      rows.map((r) => r.id).sort(),
    );
  });

  it('does nothing when no row is due', async () => {
    const { worker, fetchFn, store } = setup([], reply(202));
    await expect(worker.tick(() => now)).resolves.toEqual({
      claimed: 0,
      sent: 0,
      failed: 0,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.settle).not.toHaveBeenCalled();
  });
});

describe('DeliveryWorker.run', () => {
  it('never rethrows a failed pass', async () => {
    const { worker, store } = setup([], reply(202));
    store.claim.mockRejectedValueOnce(new Error('database down'));
    await expect(worker.run()).resolves.toBeUndefined();
  });
});
