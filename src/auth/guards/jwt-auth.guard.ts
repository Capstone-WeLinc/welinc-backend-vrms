import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { AccountCheck } from '../account-check';
import type { VerifiedToken } from '../strategies/jwt.strategy';

/**
 * Verifies the token's signature, then confirms the account with welinc-auth (spec 0009, AC-4).
 * `req.user` is built from welinc-auth's answer, never from the token's claims.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly accountCheck: AccountCheck) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);

    const request = context.switchToHttp().getRequest<Request>();
    const verified = request.user as VerifiedToken;
    const token = (request.headers.authorization ?? '').replace(
      /^Bearer\s+/i,
      '',
    );

    const { user } = await this.accountCheck.confirm(token, verified.exp);
    request.user = user;
    return true;
  }
}
