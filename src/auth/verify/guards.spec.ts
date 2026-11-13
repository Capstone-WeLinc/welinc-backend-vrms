import { HttpException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { checkPerson, requireService } from './guards';
import { ResilientKeySet } from './key-set';
import { TokenVerifier } from './token-verifier';
import {
  fakeJwksFetch,
  signAccess,
  TEST_ISSUER,
  testSigner,
  type TestSigner,
} from './testing/test-auth';

const request = (token: string | null) =>
  ({
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }) as unknown as Request & { service?: unknown };

async function answer(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  return {
    status: http.getStatus(),
    body: http.getResponse() as { code?: string; message?: string },
  };
}

// covers: spec 0002 AC-10 (401, 401 WRONG_AUDIENCE, 403 WRONG_TOKEN_USE, 503 AUTH_UNAVAILABLE), AC-12
describe('verify guards', () => {
  let signer: TestSigner;
  let jwks: ReturnType<typeof fakeJwksFetch>;
  let verifier: TokenVerifier;

  const service = (scope = 'roster.read') =>
    signAccess(signer, {
      sub: 'client:vmms',
      client_id: 'vmms',
      token_use: 'service',
      scope,
    });

  beforeAll(async () => {
    signer = await testSigner();
  });

  beforeEach(() => {
    jwks = fakeJwksFetch(() => signer.jwks);
    verifier = new TokenVerifier({
      issuer: TEST_ISSUER,
      audience: 'VRMS',
      keys: new ResilientKeySet({ url: 'http://auth/jwks', fetch: jwks.fn }),
    });
  });

  describe('checkPerson', () => {
    it('passes a person and hands back the raw token', async () => {
      const token = await signAccess(signer);
      await expect(
        checkPerson(verifier, request(token)),
      ).resolves.toMatchObject({ raw: token, token: { tokenUse: 'user' } });
    });

    it('answers 401 Invalid session for no token or a bad one', async () => {
      expect(await answer(checkPerson(verifier, request(null)))).toMatchObject({
        status: 401,
        body: { message: 'Invalid session' },
      });
      expect(
        (await answer(checkPerson(verifier, request('x.y.z')))).status,
      ).toBe(401);
    });

    it('answers 401 WRONG_AUDIENCE for a BMS token', async () => {
      expect(
        await answer(
          checkPerson(
            verifier,
            request(await signAccess(signer, { aud: 'BMS' })),
          ),
        ),
      ).toMatchObject({
        status: 401,
        body: { code: 'WRONG_AUDIENCE' },
      });
    });

    it('answers 403 WRONG_TOKEN_USE for a service token', async () => {
      expect(
        await answer(checkPerson(verifier, request(await service()))),
      ).toMatchObject({
        status: 403,
        body: { code: 'WRONG_TOKEN_USE' },
      });
    });

    it('answers 503 AUTH_UNAVAILABLE, never 401, when no key set can be fetched', async () => {
      jwks.state.down = true;
      expect(
        await answer(checkPerson(verifier, request(await signAccess(signer)))),
      ).toMatchObject({
        status: 503,
        body: {
          code: 'AUTH_UNAVAILABLE',
          message: 'Sign in service unavailable. Try again in a moment.',
        },
      });
    });
  });

  describe('requireService', () => {
    const context = (req: Request) =>
      ({
        switchToHttp: () => ({ getRequest: () => req }),
      }) as unknown as ExecutionContext;
    const guard = () =>
      new (requireService('roster.read'))(verifier) as {
        canActivate: (c: ExecutionContext) => Promise<boolean>;
      };

    it('lets a service token with the scope in and sets request.service', async () => {
      const req = request(await service());
      await expect(guard().canActivate(context(req))).resolves.toBe(true);
      expect(req.service).toMatchObject({ clientId: 'vmms' });
    });

    it('refuses a person with 403 WRONG_TOKEN_USE', async () => {
      const token = await signAccess(signer);
      expect(
        await answer(guard().canActivate(context(request(token)))),
      ).toMatchObject({ status: 403, body: { code: 'WRONG_TOKEN_USE' } });
    });

    it('refuses a service token without the scope with 403 FORBIDDEN', async () => {
      const token = await service('other.scope');
      expect(
        await answer(guard().canActivate(context(request(token)))),
      ).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    });
  });
});
