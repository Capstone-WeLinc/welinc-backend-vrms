import {
  HttpException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import {
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { AssertionSigner, parseClientKey } from './assertion-signer';
import { ServiceTokenClient } from './service-token-client';
import { TEST_ISSUER } from './testing/test-auth';

async function clientKeyJson(extra: Record<string, unknown> = {}) {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  return JSON.stringify({
    ...(await exportJWK(privateKey)),
    kid: 'vrms-test-1',
    alg: 'ES256',
    ...extra,
  });
}

// covers: spec 0002 AC-20 (a fresh assertion per request, a kept token, one shared request,
// one retry on 401, never on 403), AC-21 (no token: 503), AC-22 (the client key checks)
describe('ServiceTokenClient', () => {
  let signer: AssertionSigner;
  let clock: number;
  let bodies: URLSearchParams[];
  let answer: { status: number; body: unknown };
  let fetchMock: jest.Mock;

  beforeAll(async () => {
    signer = await AssertionSigner.create({
      clientId: 'vrms',
      privateKey: await clientKeyJson(),
      issuer: TEST_ISSUER,
    });
  });

  beforeEach(() => {
    clock = 1_000_000;
    bodies = [];
    let n = 0;
    answer = { status: 200, body: null };
    fetchMock = jest.fn((_url: string, init: RequestInit) => {
      bodies.push(init.body as URLSearchParams);
      const body = answer.body ?? {
        access_token: `svc-${++n}`,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'directory.read',
      };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: answer.status }),
      );
    });
  });

  const build = () =>
    new ServiceTokenClient({
      tokenUrl: 'http://auth-service:3001/auth/token',
      signer,
      audience: 'AUTH',
      scope: 'directory.read',
      fetch: fetchMock,
      now: () => clock,
    });

  it('asks with a fresh 60 s assertion, audience AUTH and scope directory.read', async () => {
    const client = build();
    await expect(client.token()).resolves.toBe('svc-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://auth-service:3001/auth/token');
    expect(init.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const form = bodies[0];
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    expect(form.get('audience')).toBe('AUTH');
    expect(form.get('scope')).toBe('directory.read');
    const assertion = form.get('client_assertion')!;
    expect(decodeProtectedHeader(assertion)).toEqual({
      alg: 'ES256',
      typ: 'JWT',
      kid: 'vrms-test-1',
    });
    const claims = decodeJwt(assertion);
    expect(claims).toMatchObject({
      iss: 'vrms',
      sub: 'vrms',
      aud: `${TEST_ISSUER}/token`,
    });
    expect(claims.exp! - claims.iat!).toBe(60);
  });

  it('keeps the token until 60 s before it expires, then signs a new assertion', async () => {
    const client = build();
    await client.token();
    clock += 239_000;
    await expect(client.token()).resolves.toBe('svc-1');
    clock += 2_000;
    await expect(client.token()).resolves.toBe('svc-2');
    expect(bodies[0].get('client_assertion')).not.toBe(
      bodies[1].get('client_assertion'),
    );
    expect(decodeJwt(bodies[0].get('client_assertion')!).jti).not.toBe(
      decodeJwt(bodies[1].get('client_assertion')!).jti,
    );
  });

  it('shares one request between callers who need a token at the same moment', async () => {
    const client = build();
    const tokens = await Promise.all([
      client.token(),
      client.token(),
      client.token(),
    ]);
    expect(tokens).toEqual(['svc-1', 'svc-1', 'svc-1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops the token and retries once when the call answers 401', async () => {
    const client = build();
    const seen: string[] = [];
    const result = await client.withToken((token) => {
      seen.push(token);
      if (seen.length === 1) return Promise.reject(new UnauthorizedException());
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(seen).toEqual(['svc-1', 'svc-2']);
  });

  it('retries a 401 only once, and never a 403', async () => {
    const client = build();
    let calls = 0;
    await expect(
      client.withToken(() => {
        calls++;
        return Promise.reject(new UnauthorizedException());
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      client.withToken(() => {
        calls++;
        return Promise.reject(new ForbiddenException());
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(calls).toBe(1);
  });

  it('answers 503 AUTH_UNAVAILABLE when welinc-auth refuses or cannot be reached', async () => {
    answer = { status: 401, body: { error: 'invalid_client' } };
    const refused = (await build()
      .token()
      .catch((e: unknown) => e)) as HttpException;
    expect(refused.getStatus()).toBe(503);
    expect(refused.getResponse()).toMatchObject({ code: 'AUTH_UNAVAILABLE' });

    fetchMock.mockImplementationOnce(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    const down = (await build()
      .token()
      .catch((e: unknown) => e)) as HttpException;
    expect(down.getStatus()).toBe(503);
  });
});

describe('parseClientKey', () => {
  it('accepts a private P-256 JWK with a kid and alg ES256', async () => {
    expect(parseClientKey(await clientKeyJson()).kid).toBe('vrms-test-1');
  });

  it('refuses a missing value, bad JSON, a public key, no kid and the wrong alg', async () => {
    const publicOnly = await clientKeyJson({ d: undefined });
    const noKid = await clientKeyJson({ kid: undefined });
    const wrongAlg = await clientKeyJson({ alg: 'ES384' });
    expect(() => parseClientKey(undefined)).toThrow(/missing/);
    expect(() => parseClientKey('{')).toThrow(/valid JSON/);
    expect(() => parseClientKey(publicOnly)).toThrow(/private EC P-256/);
    expect(() => parseClientKey(noKid)).toThrow(/kid/);
    expect(() => parseClientKey(wrongAlg)).toThrow(/ES256/);
  });

  it('never puts the key in the message', async () => {
    const raw = await clientKeyJson({ alg: 'RS256' });
    const d = (JSON.parse(raw) as { d: string }).d;
    let message = '';
    try {
      parseClientKey(raw);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(d);
  });
});
