import {
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountCheck, CACHE_MAX_ENTRIES, CACHE_TTL_MS } from './account-check';
import type { UserToken } from './verify';

// covers: spec 0009 AC-4, AC-7, AC-25; spec 0003 AC-1, AC-26, AC-27 (the session check)

const SESSION = {
  active: true,
  sid: 's1',
  expiresAt: '2026-11-09T09:00:00.000Z',
  user: { id: 'u1', name: 'Juan dela Cruz', email: 'mech.juan@welinc.com' },
};

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

function token(over: Partial<UserToken> = {}): UserToken {
  return {
    tokenUse: 'user',
    sub: 'u1',
    email: 'mech.juan@welinc.com',
    aud: 'VRMS',
    clientId: 'vrms',
    roles: [
      { role: 'MECHANIC', system: 'VRMS' },
      { role: 'MECHANIC', system: 'VMMS' },
    ],
    exp: inAnHour(),
    jti: 'j1',
    sid: 's1',
    ...over,
  };
}

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

const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse() as { code?: string }).code;

afterEach(() => jest.useRealTimers());

describe('AccountCheck', () => {
  it('asks /auth/session with only the caller token, names the caller from it and takes VRMS roles from the token', async () => {
    const { fetchMock, check } = setup();
    fetchMock.mockReturnValue(answer(200, SESSION));

    const { user, fresh } = await check.confirm('tok', token());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://auth-service:3001/auth/session');
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
      getOrThrow: jest.fn(() => {
        throw new Error('missing');
      }),
    } as unknown as ConfigService;
    expect(() => new AccountCheck(config)).toThrow('missing');
  });

  it('answers 401 SESSION_ENDED for a token with no sid, without asking', async () => {
    const { fetchMock, check } = setup();
    const error = await check
      .confirm('tok', token({ sid: null }))
      .catch((e: unknown) => e);
    expect((error as HttpException).getStatus()).toBe(401);
    expect(codeOf(error)).toBe('SESSION_ENDED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches by sid for 30 s, across tokens of the same session', async () => {
    jest.useFakeTimers();
    const { fetchMock, check } = setup();
    fetchMock.mockImplementation(() => answer(200, SESSION));

    await check.confirm('tok-a', token());
    const second = await check.confirm('tok-b', token({ jti: 'j2' }));
    expect(second.fresh).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(CACHE_TTL_MS + 1);
    await check.confirm('tok-b', token({ jti: 'j2' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one call among concurrent misses for one sid', async () => {
    const { fetchMock, check } = setup();
    let release: (value: Response) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const calls = [
      check.confirm('a', token()),
      check.confirm('b', token({ jti: 'j2' })),
      check.confirm('c', token({ jti: 'j3' })),
    ];
    release(new Response(JSON.stringify(SESSION), { status: 200 }));
    await Promise.all(calls);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches an ended answer until the token expires, and keeps its code', async () => {
    jest.useFakeTimers();
    const { fetchMock, check } = setup();
    fetchMock.mockImplementation(() =>
      answer(401, {
        message: 'This account is not active',
        code: 'ACCOUNT_INACTIVE',
      }),
    );
    for (let i = 0; i < 2; i++) {
      jest.advanceTimersByTime(CACHE_TTL_MS + 1);
      const error = await check
        .confirm('tok', token())
        .catch((e: unknown) => e);
      expect((error as HttpException).getStatus()).toBe(401);
      expect(codeOf(error)).toBe('ACCOUNT_INACTIVE');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes TOKEN_EXPIRED through and caches nothing for it', async () => {
    const { fetchMock, check } = setup();
    fetchMock.mockImplementation(() =>
      answer(401, { message: 'expired', code: 'TOKEN_EXPIRED' }),
    );
    for (let i = 0; i < 2; i++) {
      const error = await check
        .confirm('tok', token())
        .catch((e: unknown) => e);
      expect(codeOf(error)).toBe('TOKEN_EXPIRED');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a session answer for another user', async () => {
    const { fetchMock, check } = setup();
    fetchMock.mockReturnValue(
      answer(200, { ...SESSION, user: { ...SESSION.user, id: 'u2' } }),
    );
    const error = await check.confirm('tok', token()).catch((e: unknown) => e);
    expect(codeOf(error)).toBe('SESSION_ENDED');
  });

  it('answers 401 when the token holds no VRMS role', async () => {
    const { fetchMock, check } = setup();
    fetchMock.mockReturnValue(answer(200, SESSION));
    await expect(
      check.confirm(
        'tok',
        token({ roles: [{ role: 'ADMIN', system: 'BMS' }] }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed with 503 on a timeout, another status or an unreadable body', async () => {
    for (const reply of [
      Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
      answer(500),
      answer(200, 'not json'),
      answer(200, { active: true }),
    ]) {
      const { fetchMock, check } = setup();
      fetchMock.mockReturnValue(reply);
      await expect(check.confirm('tok', token())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    }
  });

  it('status always asks fresh and answers the server cutoff', async () => {
    const { fetchMock, check } = setup();
    fetchMock.mockImplementation(() => answer(200, SESSION));
    await check.confirm('tok', token());
    await expect(check.status('tok', token())).resolves.toEqual({
      sessionExpiresAt: SESSION.expiresAt,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('runs whenConfirmed listeners on a fresh answer only', async () => {
    const { fetchMock, check } = setup();
    fetchMock.mockImplementation(() => answer(200, SESSION));
    const listener = jest.fn(() => Promise.resolve());
    check.whenConfirmed(listener);
    await check.confirm('tok', token());
    await check.confirm('tok', token());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps at most CACHE_MAX_ENTRIES sessions', async () => {
    const { fetchMock, check } = setup();
    fetchMock.mockImplementation(() => answer(200, SESSION));
    for (let i = 0; i <= CACHE_MAX_ENTRIES; i++) {
      // a different sid each time, the same user
      await check.confirm('tok', token({ sid: `s${i}` }));
    }
    await check.confirm('tok', token({ sid: 's0' }));
    expect(fetchMock).toHaveBeenCalledTimes(CACHE_MAX_ENTRIES + 2);
  });
});
