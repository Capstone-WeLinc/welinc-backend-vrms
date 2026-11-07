import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountCheck, CACHE_MAX_ENTRIES, CACHE_TTL_MS } from './account-check';

// Spec 0009, AC-4, AC-7 and AC-25.

const ME = {
  id: 'u1',
  email: 'mech.juan@welinc.com',
  name: 'Juan dela Cruz',
  roles: [
    { role: 'MECHANIC', system: 'VRMS' },
    { role: 'MECHANIC', system: 'VMMS' },
  ],
};

function answer(status: number, body: unknown = {}) {
  return Promise.resolve(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    }),
  );
}

function setup(url = 'http://auth-service:3001/') {
  const fetchMock = jest.fn();
  global.fetch = fetchMock;
  const config = {
    getOrThrow: jest.fn().mockReturnValue(url),
  } as unknown as ConfigService;
  return { fetchMock, check: new AccountCheck(config) };
}

afterEach(() => jest.useRealTimers());

describe('AccountCheck', () => {
  it('asks /auth/me?system=VRMS with only the caller token and keeps VRMS roles', async () => {
    const { fetchMock, check } = setup();
    fetchMock.mockReturnValue(answer(200, ME));

    const { user, fresh } = await check.confirm('tok');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://auth-service:3001/auth/me?system=VRMS');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
    expect(fresh).toBe(true);
    expect(user).toEqual({
      sub: 'u1',
      email: 'mech.juan@welinc.com',
      name: 'Juan dela Cruz',
      system: 'VRMS',
      roles: [{ role: 'MECHANIC', system: 'VRMS' }],
    });
  });

  it('refuses to start without AUTH_INTERNAL_URL', () => {
    const config = {
      getOrThrow: () => {
        throw new Error('missing');
      },
    } as unknown as ConfigService;
    expect(() => new AccountCheck(config)).toThrow('missing');
  });

  it('answers 401 for a 200 with no VRMS role', async () => {
    const { fetchMock, check } = setup();
    fetchMock.mockReturnValue(
      answer(200, { ...ME, roles: [{ role: 'ADMIN', system: 'BMS' }] }),
    );
    await expect(check.confirm('tok')).rejects.toThrow(
      new UnauthorizedException('User does not have access to this system'),
    );
  });

  it.each([
    [401, 'Invalid session', UnauthorizedException],
    [
      403,
      'Account is locked. Contact your Admin to unlock.',
      ForbiddenException,
    ],
  ])('passes a %s through with its message', async (status, message, Type) => {
    const { fetchMock, check } = setup();
    fetchMock.mockReturnValue(answer(status, { message }));
    await expect(check.confirm('tok')).rejects.toThrow(new Type(message));
  });

  it.each([
    ['a 500', () => answer(500)],
    ['a 429', () => answer(429)],
    ['a 404', () => answer(404)],
    ['an unreadable body', () => answer(200, 'not json')],
    ['a body missing fields', () => answer(200, { id: 'u1' })],
    ['a timeout', () => Promise.reject(new DOMException('t', 'TimeoutError'))],
  ])('answers 503 for %s', async (_label, reply) => {
    const { fetchMock, check } = setup();
    fetchMock.mockImplementation(reply);
    await expect(check.confirm('tok')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('caches a 200 for 30 seconds, then asks again', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { fetchMock, check } = setup();
    fetchMock.mockImplementation(() => answer(200, ME));

    await check.confirm('tok');
    const second = await check.confirm('tok');
    expect(second.fresh).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    jest.setSystemTime(1_000_000 + CACHE_TTL_MS + 1);
    await check.confirm('tok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ends a cache entry at the token's exp when that comes first", async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { fetchMock, check } = setup();
    fetchMock.mockImplementation(() => answer(200, ME));

    const exp = (1_000_000 + 5_000) / 1000;
    await check.confirm('tok', exp);
    jest.setSystemTime(1_000_000 + 5_001);
    await check.confirm('tok', exp);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never caches a 401, 403 or 5xx', async () => {
    const { fetchMock, check } = setup();
    fetchMock
      .mockImplementationOnce(() => answer(503))
      .mockImplementationOnce(() => answer(401, { message: 'Invalid session' }))
      .mockImplementation(() => answer(200, ME));

    await expect(check.confirm('tok')).rejects.toThrow();
    await expect(check.confirm('tok')).rejects.toThrow();
    await expect(check.confirm('tok')).resolves.toMatchObject({ fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('shares one call between checks for the same token already in flight', async () => {
    const { fetchMock, check } = setup();
    fetchMock.mockImplementation(() => answer(200, ME));

    const [a, b] = await Promise.all([
      check.confirm('tok'),
      check.confirm('tok'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([a.fresh, b.fresh].sort()).toEqual([false, true]);
  });

  // covers: AC-4 (capped at 5,000 entries, oldest dropped first)
  describe('cache cap', () => {
    async function fill(check: AccountCheck, count: number) {
      for (let i = 0; i < count; i++) await check.confirm(`tok-${i}`);
    }

    it('keeps every answer while the cache is at its cap', async () => {
      const { fetchMock, check } = setup();
      fetchMock.mockImplementation(() => answer(200, ME));

      await fill(check, CACHE_MAX_ENTRIES);
      fetchMock.mockClear();
      const again = await check.confirm('tok-0');

      expect(again.fresh).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('drops the oldest entry first when one more token arrives', async () => {
      const { fetchMock, check } = setup();
      fetchMock.mockImplementation(() => answer(200, ME));

      await fill(check, CACHE_MAX_ENTRIES + 1);
      fetchMock.mockClear();

      const newest = await check.confirm(`tok-${CACHE_MAX_ENTRIES}`);
      expect(newest.fresh).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();

      const oldest = await check.confirm('tok-0');
      expect(oldest.fresh).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
