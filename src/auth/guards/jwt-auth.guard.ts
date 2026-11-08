import {
  ExecutionContext,
  Inject,
  Injectable,
  type CanActivate,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AccountCheck, type AuthUser } from '../account-check';
import { PUBLIC_KEY } from '../permissions/permission.decorators';
import {
  checkPerson,
  SERVICE_ROUTE_KEY,
  TOKEN_VERIFIER,
  TokenVerifier,
} from '../verify';

/**
 * Checks the token against welinc-auth's published keys (spec 0002, AC-10), refuses a service
 * token, then confirms the account with welinc-auth (spec 0009, AC-4). `req.user` is built from
 * welinc-auth's answer, never from the token's claims. Global; a `@Public()` route skips it
 * (spec 0011, AC-7), and so does a `@ServiceRoute()`, which has its own guard.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    private readonly accountCheck: AccountCheck,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets))
      return true;
    if (this.reflector.getAllAndOverride<string>(SERVICE_ROUTE_KEY, targets))
      return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    const { raw, token } = await checkPerson(this.verifier, request);
    const { user } = await this.accountCheck.confirm(raw, token);
    request.user = user;
    return true;
  }
}
