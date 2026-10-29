import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { AccountCheck, AuthUser } from '../account-check';
import { FakeAccountCheck } from '../account-check.fake';
import { SystemType, UserRole } from '../roles';
import { JwtAuthGuard } from './jwt-auth.guard';

// Spec 0009, AC-4: after the signature check, req.user comes from welinc-auth's answer, never
// from the token's claims.

type Req = {
  headers: Record<string, string | undefined>;
  user?: unknown;
};

const mechanic: AuthUser = {
  sub: 'confirmed-id',
  email: 'mech.juan@welinc.com',
  name: 'Juan dela Cruz',
  system: SystemType.VRMS,
  roles: [{ role: UserRole.MECHANIC, system: SystemType.VRMS }],
};

function setup(authorization: string | undefined = 'Bearer abc.def.ghi') {
  const request: Req = {
    headers: { authorization },
    user: { sub: 'token-claim-id', exp: 1_900_000_000 },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  const check = new FakeAccountCheck(mechanic);
  const confirm = jest.spyOn(check, 'confirm');
  const guard = new JwtAuthGuard(
    check as unknown as AccountCheck,
    new Reflector(),
  );
  // The signature check is passport's; the guard under test is what runs after it
  const signature = jest
    .spyOn(
      AuthGuard('jwt').prototype as { canActivate: () => unknown },
      'canActivate',
    )
    .mockResolvedValue(true);
  return { guard, request, context, confirm, signature, check };
}

afterEach(() => jest.restoreAllMocks());

describe('JwtAuthGuard', () => {
  it("replaces req.user with welinc-auth's answer, not the token's claims", async () => {
    const { guard, request, context } = setup();

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.user).toEqual(mechanic);
  });

  it('asks about the bare token and passes the token exp for the cache', async () => {
    const { guard, context, confirm } = setup('Bearer abc.def.ghi');

    await guard.canActivate(context);

    expect(confirm).toHaveBeenCalledWith('abc.def.ghi', 1_900_000_000);
  });

  it('reads the Bearer prefix whatever its case', async () => {
    const { guard, context, confirm } = setup('bearer abc.def.ghi');

    await guard.canActivate(context);

    expect(confirm).toHaveBeenCalledWith('abc.def.ghi', 1_900_000_000);
  });

  it('never asks welinc-auth when the signature check fails', async () => {
    const { guard, context, confirm, signature } = setup();
    signature.mockRejectedValue(new UnauthorizedException());

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(confirm).not.toHaveBeenCalled();
  });

  it('lets a 503 from the account check through and does not trust the token', async () => {
    const { guard, request, context, check } = setup();
    check.error = new ServiceUnavailableException(
      'Sign in service unavailable. Try again in a moment.',
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(request.user).not.toEqual(mechanic);
  });

  it('lets a 401 from the account check through', async () => {
    const { guard, context, check } = setup();
    check.error = new UnauthorizedException(
      'User does not have access to this system',
    );

    await expect(guard.canActivate(context)).rejects.toThrow(
      'User does not have access to this system',
    );
  });
});
