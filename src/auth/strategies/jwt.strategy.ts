import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { SystemType } from '@prisma/client';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      passReqToCallback: true,
    });
  }

  validate(
    request: Request,
    payload: {
      sub: string;
      email: string;
      roles: { role: string; system: string }[];
      system?: string;
    },
  ) {
    if (!payload || !payload.sub || !payload.email) {
      throw new UnauthorizedException('Invalid session');
    }

    let requestedSystem = (payload.system || '') as SystemType;

    if (
      !requestedSystem ||
      !Object.values(SystemType).includes(requestedSystem)
    ) {
      const referer = request.headers?.referer || '';
      const origin = request.headers?.origin || '';
      const source = (referer + '|' + origin).toLowerCase();

      if (source.includes(':8001') || source.includes('vrms')) {
        requestedSystem = SystemType.VRMS;
      } else if (source.includes(':8002') || source.includes('vmms')) {
        requestedSystem = SystemType.VMMS;
      } else if (source.includes(':8003') || source.includes('bms')) {
        requestedSystem = SystemType.BMS;
      } else {
        requestedSystem = SystemType.VRMS;
      }
    }

    const roles = payload.roles || [];

    return {
      sub: payload.sub,
      email: payload.email,
      roles: roles,
      system: requestedSystem,
    };
  }
}
