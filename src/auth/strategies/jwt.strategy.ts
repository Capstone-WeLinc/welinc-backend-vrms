import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { SystemType } from "@prisma/client";
import { PrismaService } from "../../shared/prisma.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("JWT_SECRET"),
      passReqToCallback: true,
    });
  }

  async validate(
    request: any,
    payload: {
      sub: string;
      email: string;
      roles: { role: string; system: string }[];
      system?: string;
    },
  ) {
    let requestedSystem = (payload.system || '') as SystemType;

    if (!requestedSystem || !Object.values(SystemType).includes(requestedSystem)) {
      // 1. Check referer/origin headers
      const referer = request.headers.referer || '';
      const origin = (request.headers.origin as string) || '';
      const source = (referer + '|' + origin).toLowerCase();

      if (source.includes(':8001') || source.includes('vrms')) {
        requestedSystem = SystemType.VRMS;
      } else if (source.includes(':8002') || source.includes('vmms')) {
        requestedSystem = SystemType.VMMS;
      } else if (source.includes(':8003') || source.includes('bms')) {
        requestedSystem = SystemType.BMS;
      }

      // 2. Fallback to path checking
      if (!requestedSystem) {
        const path = request.path || request.url || '';
        if (path.includes('/vrms') || path.includes('vrms/')) {
          requestedSystem = SystemType.VRMS;
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
          requestedSystem = SystemType.VMMS;
        } else if (
          path.includes('/bms') ||
          path.includes('bms/') ||
          path.startsWith('/booking') ||
          path.startsWith('/scheduling')
        ) {
          requestedSystem = SystemType.BMS;
        }
      }

      // 3. Fallback to query parameter system
      if (!requestedSystem && request.query?.system) {
        requestedSystem = String(request.query.system).toUpperCase() as SystemType;
      }

      // 4. Fallback to body roleAssignments system
      if (!requestedSystem && (request.body as any)?.roleAssignments?.[0]?.system) {
        requestedSystem = String((request.body as any).roleAssignments[0].system).toUpperCase() as SystemType;
      }
    }

    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      select: {
        id: true,
        email: true,
        isActive: true,
        lockedAt: true,
        roles: {
          select: {
            role: true,
            system: true,
          },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException("Invalid session");
    }

    if (user.lockedAt !== null) {
      throw new ForbiddenException(
        "Account is locked. Contact your Admin to unlock.",
      );
    }

    // Resolve system from user's roles if still empty
    if (!requestedSystem || !Object.values(SystemType).includes(requestedSystem)) {
      if (user.roles.length > 0) {
        requestedSystem = user.roles[0].system;
      } else {
        requestedSystem = SystemType.VRMS;
      }
    }

    const rolesForSystem = user.roles.filter(
      (assignment) => assignment.system === requestedSystem,
    );

    if (rolesForSystem.length === 0) {
      throw new UnauthorizedException(
        "User does not have access to this system",
      );
    }

    return {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      system: requestedSystem,
    };
  }
}
