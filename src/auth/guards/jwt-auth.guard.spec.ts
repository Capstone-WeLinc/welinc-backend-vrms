import {
  ExecutionContext,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AccountCheck, AuthUser } from '../account-check';
import { FakeAccountCheck } from '../account-check.fake';
import { PUBLIC_KEY } from '../permissions/permission.decorators';
import { SystemType } from '../roles';
import { UserRole } from '../built-in-roles.testing';
import { ResilientKeySet, SERVICE_ROUTE_KEY, TokenVerifier } from '../verify';
import {
  fakeJwksFetch,
  signAccess,
  TEST_ISSUER,
  testSigner,
  type TestSigner,
} from '../verify/testing/test-auth';
import { JwtAuthGuard } from './jwt-auth.guard';

// Spec 0002, AC-10: the token is checked with welinc-auth's published keys before the account
// check. Spec 0009, AC-4: req.user comes from welinc-auth's answer, never from the token's claims.

type Req = { headers: Record<string, string | undefined>; user?: unknown };

const mechanic: AuthUser = {
  sub: 'confirmed-id',
  email: 'mech.juan@welinc.com',
  name: 'Juan dela Cruz',
  system: SystemType.VRMS,
  roles: [{ role: UserRole.MECHANIC, system: SystemType.VRMS }],
};

let signer: TestSigner;
beforeAll(async () => {
  signer = await testSigner();
});
afterEach(() => jest.restoreAllMocks());

function setup(
  authorization: string | undefined,
  handler: () => void = () => undefined,
) {
  const request: Req = { headers: { authorization } };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  const jwks = fakeJwksFetch(() => signer.jwks);
  const verifier = new TokenVerifier({
    issuer: TEST_ISSUER,
    audience: 'VRMS',
    keys: new ResilientKeySet({ url: 'http://auth/jwks', fetch: jwks.fn }),
  });
  const check = new FakeAccountCheck(mechanic);
  const confirm = jest.spyOn(check, 'confirm');
  const guard = new JwtAuthGuard(
    verifier,
    check as unknown as AccountCheck,
    new Reflector(),
  );
  return { guard, request, context, confirm, check, jwks };
}

describe('JwtAuthGuard', () => {
  it("replaces req.user with welinc-auth's answer, not the token's claims", async () => {
    const { guard, request, context } = setup(
      `Bearer ${await signAccess(signer, { sub: 'token-claim-id' })}`,
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(mechanic);
  });

  it('asks about the bare token and passes the checked token for the session cache', async () => {
    const token = await signAccess(signer);
    const { guard, context, confirm } = setup(`bearer ${token}`);
    await guard.canActivate(context);
    const [raw, checked] = confirm.mock.calls[0] as unknown as [
      string,
      { tokenUse: string; exp: number },
    ];
    expect(raw).toBe(token);
    expect(checked.tokenUse).toBe('user');
    expect(checked.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('never asks welinc-auth when the token check fails', async () => {
    const { guard, context, confirm } = setup('Bearer not.a.token');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it('answers a BMS token with 401 WRONG_AUDIENCE before any account check', async () => {
    const { guard, context, confirm } = setup(
      `Bearer ${await signAccess(signer, { aud: 'BMS' })}`,
    );
    const error = (await guard
      .canActivate(context)
      .catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(401);
    expect(error.getResponse()).toMatchObject({ code: 'WRONG_AUDIENCE' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('answers a service token with 403 WRONG_TOKEN_USE and never sends it to the account check', async () => {
    const token = await signAccess(signer, {
      sub: 'client:vmms',
      client_id: 'vmms',
      token_use: 'service',
      scope: 'x',
    });
    const { guard, context, confirm } = setup(`Bearer ${token}`);
    const error = (await guard
      .canActivate(context)
      .catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({ code: 'WRONG_TOKEN_USE' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('answers 503 AUTH_UNAVAILABLE when the keys cannot be fetched', async () => {
    const { guard, context, jwks } = setup(
      `Bearer ${await signAccess(signer)}`,
    );
    jwks.state.down = true;
    const error = (await guard
      .canActivate(context)
      .catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(503);
  });

  it('skips @Public() and @ServiceRoute() routes', async () => {
    for (const key of [PUBLIC_KEY, SERVICE_ROUTE_KEY]) {
      const handler = () => undefined;
      Reflect.defineMetadata(
        key,
        key === PUBLIC_KEY ? true : 'x.read',
        handler,
      );
      const { guard, context, confirm } = setup(undefined, handler);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    }
  });

  it('lets a 503 or a 401 from the account check through', async () => {
    const token = `Bearer ${await signAccess(signer)}`;
    const a = setup(token);
    a.check.error = new ServiceUnavailableException(
      'Sign in service unavailable. Try again in a moment.',
    );
    await expect(a.guard.canActivate(a.context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(a.request.user).toBeUndefined();

    const b = setup(token);
    b.check.error = new UnauthorizedException(
      'User does not have access to this system',
    );
    await expect(b.guard.canActivate(b.context)).rejects.toThrow(
      'User does not have access to this system',
    );
  });
});
