import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

/** What the signature check passes on; JwtAuthGuard then asks welinc-auth who the caller is. */
export type VerifiedToken = { sub: string; exp?: number };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: { sub?: string; exp?: number }): VerifiedToken {
    if (!payload || !payload.sub) {
      throw new UnauthorizedException('Invalid session');
    }
    return { sub: payload.sub, exp: payload.exp };
  }
}
