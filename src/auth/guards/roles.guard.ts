import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

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
    const user = request.user as {
      sub: string;
      email: string;
      roles: { role: UserRole; system: string }[];
      system: string;
    };

    if (!user) {
      return false;
    }

    // Infer system context if missing
    let targetSystem = user.system;
    if (!targetSystem) {
      // 1. Check referer/origin headers
      const referer = request.headers.referer || '';
      const origin = (request.headers.origin as string) || '';
      const source = (referer + '|' + origin).toLowerCase();

      if (source.includes(':8001') || source.includes('vrms')) {
        targetSystem = 'VRMS';
      } else if (source.includes(':8002') || source.includes('vmms')) {
        targetSystem = 'VMMS';
      } else if (source.includes(':8003') || source.includes('bms')) {
        targetSystem = 'BMS';
      }

      // 2. Fallback to path checking
      if (!targetSystem) {
        const path = request.path || request.url || '';
        if (path.includes('/vrms') || path.includes('vrms/')) {
          targetSystem = 'VRMS';
        } else if (
          path.includes('/vmms') ||
          path.includes('vmms/') ||
          path.startsWith('/checklists') ||
          path.startsWith('/maintenance-schedules') ||
          path.startsWith('/vehicles') ||
          path.startsWith('/drivers') ||
          path.startsWith('/garages') ||
          path.startsWith('/locations')
        ) {
          targetSystem = 'VMMS';
        } else if (
          path.includes('/bms') ||
          path.includes('bms/') ||
          path.startsWith('/booking') ||
          path.startsWith('/scheduling')
        ) {
          targetSystem = 'BMS';
        }
      }

      // 3. Fallback to query parameter system
      if (!targetSystem && request.query?.system) {
        targetSystem = String(request.query.system).toUpperCase();
      }

      // 4. Fallback to body roleAssignments system
      if (!targetSystem && (request.body as any)?.roleAssignments?.[0]?.system) {
        targetSystem = String((request.body as any).roleAssignments[0].system).toUpperCase();
      }

      user.system = targetSystem;
    }

    return requiredRoles.some((requiredRole) =>
      user.roles.some(
        (assignment) =>
          assignment.role === requiredRole &&
          assignment.system === targetSystem,
      ),
    );
  }
}

