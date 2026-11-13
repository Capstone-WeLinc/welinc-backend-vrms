import {
  applyDecorators,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  authUnavailable,
  invalidSession,
  missingScope,
  tokenExpired,
  wrongAudience,
  wrongTokenUse,
} from './errors';
import {
  TokenCheckError,
  TokenVerifier,
  type ServiceToken,
  type UserToken,
} from './token-verifier';

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** Marks a route meant for services; a guard for people should skip it. */
export const SERVICE_ROUTE_KEY = 'auth:serviceRoute';

export function bearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Runs the verifier and maps a refusal to its HTTP answer: 401, 401 `TOKEN_EXPIRED`, 401
 * `WRONG_AUDIENCE` or 503.
 */
export async function checkBearer(
  verifier: TokenVerifier,
  request: Request,
): Promise<{ raw: string; token: UserToken | ServiceToken }> {
  const raw = bearerToken(request);
  if (!raw) throw invalidSession();
  try {
    return { raw, token: await verifier.verify(raw) };
  } catch (error) {
    if (!(error instanceof TokenCheckError)) throw error;
    if (error.failure === 'unavailable') throw authUnavailable();
    if (error.failure === 'wrong_audience') throw wrongAudience();
    if (error.failure === 'expired') throw tokenExpired();
    throw invalidSession();
  }
}

/**
 * For routes meant for people: checks the token and refuses a service token with 403
 * `WRONG_TOKEN_USE`, before any account check sees it (spec 0002, AC-10).
 */
export async function checkPerson(
  verifier: TokenVerifier,
  request: Request,
): Promise<{ raw: string; token: UserToken }> {
  const { raw, token } = await checkBearer(verifier, request);
  if (token.tokenUse !== 'user') {
    throw wrongTokenUse('This route is for people, not services');
  }
  return { raw, token };
}

/**
 * A guard for routes meant for services: a person's token answers 403 `WRONG_TOKEN_USE`, a
 * service token without `scope` 403 `FORBIDDEN` (contract 0001 section 4, version 8). The checked token is put on `request.service`.
 */
export function requireService(scope: string): Type<CanActivate> {
  @Injectable()
  class RequireServiceGuard implements CanActivate {
    constructor(
      @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const request = context
        .switchToHttp()
        .getRequest<Request & { service?: ServiceToken }>();
      const { token } = await checkBearer(this.verifier, request);
      if (token.tokenUse !== 'service') {
        throw wrongTokenUse('This route is for services, not people');
      }
      if (!token.scopes.includes(scope)) {
        throw missingScope(scope);
      }
      request.service = token;
      return true;
    }
  }
  return RequireServiceGuard;
}

/** `@ServiceRoute('scope')`: marks the route for services and guards it with `requireService`. */
export const ServiceRoute = (scope: string) =>
  applyDecorators(
    SetMetadata(SERVICE_ROUTE_KEY, scope),
    UseGuards(requireService(scope)),
  );
