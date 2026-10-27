import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UserRole } from '../roles';
import { ROLES_KEY } from '../decorators/roles.decorator';
import type { AuthUser } from '../account-check';

/** Runs after JwtAuthGuard, on the VRMS roles welinc-auth confirmed. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as AuthUser | undefined;

    if (!user) {
      return false;
    }

    return requiredRoles.some((requiredRole) =>
      user.roles.some(
        (assignment) =>
          assignment.role === requiredRole && assignment.system === user.system,
      ),
    );
  }
}
