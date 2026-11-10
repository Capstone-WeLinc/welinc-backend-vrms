import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env';
import type { ServiceTokenClient } from '../../../auth/verify';
import {
  AuthDirectoryClient,
  DirectoryCursorError,
  DirectoryUnavailableError,
  type DirectoryUser,
} from './auth-directory.client';

// Spec 0005, AC-12 to AC-15: how VRMS reads welinc-auth's directory and what each failure
// becomes (a refused cursor means read everything again, anything else means "unavailable").

const person = (id: string): DirectoryUser => ({
  id,
  name: id,
  email: `${id}@welinc.com`,
  phone: null,
  phoneVerified: false,
  picture: null,
  isActive: true,
  deleted: false,
  roles: ['MECHANIC'],
  updatedAt: '2026-11-09T00:00:00.000Z',
});

const reply = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
  });

describe('AuthDirectoryClient', () => {
  let fetchMock: jest.SpyInstance;
  const callOf = (i: number) =>
    fetchMock.mock.calls[i] as unknown as [string, RequestInit];
  let client: AuthDirectoryClient;
  let tokenCalls: number;

  beforeEach(() => {
    tokenCalls = 0;
    // Same retry rule as the real ServiceTokenClient: one more try after a 401
    const tokens = {
      withToken: async <T>(call: (token: string) => Promise<T>) => {
        tokenCalls += 1;
        try {
          return await call('token-1');
        } catch (error) {
          if (!(error instanceof UnauthorizedException)) throw error;
          tokenCalls += 1;
          return call('token-2');
        }
      },
    } as unknown as ServiceTokenClient;
    const env = {
      get: () => 'http://auth:3001/',
    } as unknown as ConfigService<Env, true>;
    client = new AuthDirectoryClient(env, tokens);
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  it('asks for a page of users with the service token and no cursor on the first read', async () => {
    fetchMock.mockResolvedValue(
      reply(200, { users: [person('a')], next: 'n1', changesCursor: 'c1' }),
    );
    const page = await client.listUsers(null);
    expect(page).toEqual({
      users: [person('a')],
      next: 'n1',
      changesCursor: 'c1',
    });
    const [url, init] = callOf(0);
    expect(url).toBe('http://auth:3001/auth/directory/users?limit=500');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-1',
    );
  });

  it('sends the page cursor and the feed position when it has them', async () => {
    fetchMock
      .mockResolvedValueOnce(
        reply(200, { users: [], next: null, changesCursor: 'c1' }),
      )
      .mockResolvedValueOnce(
        reply(200, { changes: [], next: 'n2', hasMore: false }),
      );
    await client.listUsers('page-2');
    await client.changes('pos-1');
    expect(callOf(0)[0]).toContain('cursor=page-2');
    expect(callOf(1)[0]).toBe(
      'http://auth:3001/auth/directory/changes?limit=100&after=pos-1',
    );
  });

  it('reads feed changes with their user', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        changes: [
          { cursor: 'x', type: 'updated', at: '2026-11-09', user: person('a') },
        ],
        next: 'x',
        hasMore: true,
      }),
    );
    const page = await client.changes(null);
    expect(page.hasMore).toBe(true);
    expect(page.changes[0]).toMatchObject({ cursor: 'x', type: 'updated' });
    expect(page.changes[0].user.id).toBe('a');
  });

  it('posts the ids to the lookup and returns who is missing', async () => {
    fetchMock.mockResolvedValue(
      reply(200, { users: [person('a')], missing: ['b'] }),
    );
    const answer = await client.lookup(['a', 'b']);
    expect(answer).toEqual({ users: [person('a')], missing: ['b'] });
    const [url, init] = callOf(0);
    expect(url).toBe('http://auth:3001/auth/directory/users/lookup');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ ids: ['a', 'b'] });
  });

  it('turns 400 INVALID_CURSOR into DirectoryCursorError', async () => {
    fetchMock.mockResolvedValue(reply(400, { code: 'INVALID_CURSOR' }));
    await expect(client.changes('old')).rejects.toBeInstanceOf(
      DirectoryCursorError,
    );
  });

  it.each([
    [500, 'status 500'],
    [429, 'status 429'],
    [403, 'status 403'],
    [400, 'status 400'],
  ])(
    'turns a %i answer into DirectoryUnavailableError',
    async (status, why) => {
      fetchMock.mockResolvedValue(reply(status, { message: 'no' }));
      await expect(client.listUsers(null)).rejects.toMatchObject({
        name: 'DirectoryUnavailableError',
        reason: why,
      });
    },
  );

  it('keeps the error code in the reason for a coded refusal', async () => {
    fetchMock.mockResolvedValue(reply(429, { code: 'RATE_LIMITED' }));
    await expect(client.listUsers(null)).rejects.toMatchObject({
      reason: 'status 429 RATE_LIMITED',
    });
  });

  it('retries once with a new token after a 401, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(401, {}))
      .mockResolvedValueOnce(reply(200, { users: [], missing: [] }));
    await expect(client.lookup(['a'])).resolves.toEqual({
      users: [],
      missing: [],
    });
    expect(tokenCalls).toBe(2);
    const second = callOf(1)[1];
    expect((second.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-2',
    );
  });

  it('says unavailable when the token client gives up with an HttpException', async () => {
    const failing = new AuthDirectoryClient(
      { get: () => 'http://auth:3001' } as unknown as ConfigService<Env, true>,
      {
        withToken: () => Promise.reject(new HttpException('down', 503)),
      } as unknown as ServiceTokenClient,
    );
    await expect(failing.listUsers(null)).rejects.toMatchObject({
      reason: 'status 503',
    });
  });

  it('says unavailable when there is no answer at all', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('boom'), { name: 'TimeoutError' }),
    );
    await expect(client.listUsers(null)).rejects.toMatchObject({
      reason: 'TimeoutError',
    });
    fetchMock.mockRejectedValue('weird');
    await expect(client.listUsers(null)).rejects.toMatchObject({
      reason: 'network error',
    });
  });

  it.each([
    ['not JSON', 'oops'],
    ['users missing', { next: null, changesCursor: 'c' }],
    [
      'a user with the wrong shape',
      { users: [{ id: 1 }], next: null, changesCursor: 'c' },
    ],
    ['no changesCursor', { users: [], next: null }],
  ])('refuses an unreadable users page (%s)', async (_label, body) => {
    fetchMock.mockResolvedValue(reply(200, body));
    await expect(client.listUsers(null)).rejects.toBeInstanceOf(
      DirectoryUnavailableError,
    );
  });

  it('refuses an unreadable feed page or lookup answer', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, {
        changes: [{ cursor: 'x', type: 'updated' }],
        next: 'x',
        hasMore: false,
      }),
    );
    await expect(client.changes(null)).rejects.toMatchObject({
      reason: 'unreadable answer',
    });
    fetchMock.mockResolvedValueOnce(
      reply(200, { changes: [], next: 'x', hasMore: 'yes' }),
    );
    await expect(client.changes(null)).rejects.toBeInstanceOf(
      DirectoryUnavailableError,
    );
    fetchMock.mockResolvedValueOnce(reply(200, { users: [], missing: [1] }));
    await expect(client.lookup(['a'])).rejects.toBeInstanceOf(
      DirectoryUnavailableError,
    );
  });
});
