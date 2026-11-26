import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env';
import type { ServiceTokens } from '../service-tokens';
import { BmsScheduleClient, parseTrips } from './bms-schedule.client';

// covers: spec 0029 AC-16 (the live trips read from BMS, child 0003)

const trip = {
  bookingNumber: 'BK-2026-0418',
  jobOrderNumber: 'JO-2026-0142',
  serviceDate: '2026-11-29',
  dispatchTime: '06:30',
  status: 'CONFIRMED',
};

function setup(...answers: (() => Promise<Response>)[]) {
  const client = {
    token: jest.fn(() => Promise.resolve('svc')),
    drop: jest.fn(),
  };
  const tokens = { for: jest.fn(() => client) };
  const fetchFn = jest.fn();
  for (const a of answers) fetchFn.mockImplementationOnce(a);
  const config = {
    get: () => 'http://api-gateway:3000/',
  } as unknown as ConfigService<Env, true>;
  const bms = new BmsScheduleClient(
    tokens as unknown as ServiceTokens,
    config,
    fetchFn,
  );
  return { bms, client, tokens, fetchFn };
}

const json = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('parseTrips', () => {
  it('keeps only the agreed fields of well formed items', () => {
    expect(
      parseTrips({
        items: [
          { ...trip, clientName: 'Acme', address: 'Somewhere', rate: 9000 },
          { ...trip, serviceDate: 'tomorrow' },
          { ...trip, jobOrderNumber: undefined, dispatchTime: '6am' },
        ],
      }),
    ).toEqual([trip, { ...trip, jobOrderNumber: null, dispatchTime: null }]);
  });

  it('answers null for a body without items', () => {
    expect(parseTrips({})).toBeNull();
    expect(parseTrips(null)).toBeNull();
  });
});

describe('BmsScheduleClient.upcomingTrips', () => {
  it('reads 14 days through the gateway with a schedule.read token', async () => {
    const { bms, tokens, fetchFn } = setup(json(200, { items: [trip] }));
    await expect(bms.upcomingTrips('v1')).resolves.toEqual([trip]);
    expect(tokens.for).toHaveBeenCalledWith('BMS', 'schedule.read');
    expect((fetchFn.mock.calls[0] as unknown[])[0]).toBe(
      'http://api-gateway:3000/bms/integrations/vrms/vehicles/v1/schedule?days=14',
    );
  });

  it('tries once more with a fresh token after a 401', async () => {
    const { bms, client } = setup(json(401, {}), json(200, { items: [] }));
    await expect(bms.upcomingTrips('v1')).resolves.toEqual([]);
    expect(client.drop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 503', json(503, {})],
    ['a 404 (BMS has no route yet)', json(404, {})],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('answers null on %s', async (_name, answer) => {
    const { bms } = setup(answer);
    await expect(bms.upcomingTrips('v1')).resolves.toBeNull();
  });
});
