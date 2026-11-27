import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ModuleDisabledException } from '../../settings/module-disabled';
import { SettingsService } from '../../settings/settings.service';
import type { AuthUser } from '../account-check';
import { SERVICE_ROUTE_KEY } from '../verify/guards';
import type { AppAbility } from './ability.factory';
import { catalogEntry, type PermissionKey } from './catalog';
import {
  AUTHENTICATED_KEY,
  PERMISSION_KEY,
  PUBLIC_KEY,
} from './permission.decorators';
import { PermissionsService } from './permissions.service';

export const DENIED = 'You do not have permission to do that.';

export type PermittedRequest = Request & {
  user: AuthUser;
  ability: AppAbility;
};

/**
 * Global, after JwtAuthGuard. Denies any route without a decorator (AC-7), checks the route's
 * key against the caller's ability (AC-8), and leaves that ability on the request for services.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
    private readonly settings: SettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) {
      return true;
    }
    // A service route has no person: its own guard checks the token, scope and client
    if (this.reflector.getAllAndOverride<string>(SERVICE_ROUTE_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<PermittedRequest>();
    const keys = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(
      PERMISSION_KEY,
      targets,
    );
    const authenticated = this.reflector.getAllAndOverride<boolean>(
      AUTHENTICATED_KEY,
      targets,
    );

    if (!keys && !authenticated) {
      this.logger.warn(
        `Route has no permission decorator: ${request.method} ${routePath(request)}`,
      );
      throw new ForbiddenException(DENIED);
    }

    await this.permissions.ensureFresh();
    // Suite spec 0018 child 0002, AC-32: a role made seconds ago gets its keys on this request
    await this.permissions.ensureKnown(request.user.roles.map((r) => r.role));
    const ability = this.permissions.abilityFor(request.user);
    request.ability = ability;

    if (!keys) return true;

    // Spec 0012, AC-11: the module before the role, so every role gets the same answer. A route
    // is off when every key it accepts belongs to a module that is off.
    const modules = keys.map((key) => catalogEntry(key)?.module);
    const offModule = modules[0];
    if (offModule && modules.every((m) => m && !this.settings.isModuleOn(m))) {
      throw new ModuleDisabledException(offModule);
    }

    if (keys.some((key) => ability.can(key, 'Permission'))) return true;

    // A log line, never a database row (AC-8)
    this.logger.warn(
      JSON.stringify({
        event: 'permission_denied',
        userId: request.user.sub,
        roles: request.user.roles.map((r) => r.role),
        permission: keys,
        method: request.method,
        route: routePath(request),
      }),
    );
    throw new ForbiddenException({
      statusCode: 403,
      message: DENIED,
      permission: keys[0],
    });
  }
}

/** The route pattern (`/vrms/repairs/:id`), so log lines never carry ids from the URL. */
function routePath(request: Request): string {
  const route = request.route as { path?: unknown } | undefined;
  const path = typeof route?.path === 'string' ? route.path : request.path;
  return `${request.baseUrl ?? ''}${path}`;
}
