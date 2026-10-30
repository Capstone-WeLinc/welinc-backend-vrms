import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../account-check';
import { SystemType, UserRole } from '../roles';
import {
  Authenticated,
  Public,
  RequirePermission,
} from './permission.decorators';
import { FakePermissions } from './permissions.fake';
import { DENIED, PermissionsGuard } from './permissions.guard';
import type { PermissionsService } from './permissions.service';
import { FakeSettings } from '../../settings/settings.fake';

const mechanic: AuthUser = {
  sub: 'm',
  email: 'mech.juan@welinc.com',
  name: 'Juan dela Cruz',
  system: SystemType.VRMS,
  roles: [{ role: UserRole.MECHANIC, system: SystemType.VRMS }],
};

class Routes {
  @Public()
  health() {}

  @Authenticated()
  me() {}

  @RequirePermission('config.read')
  garages() {}

  @RequirePermission('audit.view', 'ticket.create')
  adminOnly() {}

  @RequirePermission('knowledge.edit')
  knowledgeEdit() {}

  undecorated() {}
}

function run(
  handler: keyof Routes,
  user: AuthUser | undefined = mechanic,
  settings = new FakeSettings(),
) {
  const request: Record<string, unknown> = {
    user,
    method: 'GET',
    path: '/x',
  };
  const context = {
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const guard = new PermissionsGuard(
    new Reflector(),
    new FakePermissions() as unknown as PermissionsService,
    settings,
  );
  return { result: guard.canActivate(context), request };
}

describe('PermissionsGuard', () => {
  it('lets a public route through with no user', async () => {
    await expect(run('health', undefined).result).resolves.toBe(true);
  });

  it('lets any signed in user through an @Authenticated route and leaves the ability', async () => {
    const { result, request } = run('me');

    await expect(result).resolves.toBe(true);
    expect(request.ability).toBeDefined();
  });

  it('allows a route whose key the caller holds', async () => {
    await expect(run('garages').result).resolves.toBe(true);
  });

  it('answers 403 with the AC-8 body when the caller holds none of the keys', async () => {
    const error = await run('adminOnly').result.catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual({
      statusCode: 403,
      message: DENIED,
      permission: 'audit.view',
    });
  });

  it('denies a route with no decorator (AC-7)', async () => {
    await expect(run('undecorated').result).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  // Spec 0012, AC-11
  it('answers MODULE_DISABLED before the role check, the same for every role', async () => {
    const settings = new FakeSettings({ 'module.knowledge': false });
    // A mechanic does not hold knowledge.edit, yet gets the module answer, not the key answer
    const error = await run('knowledgeEdit', mechanic, settings).result.catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual({
      statusCode: 403,
      code: 'MODULE_DISABLED',
      module: 'knowledge',
      message: 'This module is turned off by your Admin.',
    });
  });

  it('leaves routes of other modules and of no module alone', async () => {
    const settings = new FakeSettings({ 'module.ai': false });
    await expect(run('garages', mechanic, settings).result).resolves.toBe(true);
  });
});
