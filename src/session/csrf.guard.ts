import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { SESSION_CONFIG, type SessionConfig } from './session.config';

/**
 * The CSRF check for the cookie routes (spec 0001 section 7, spec 0003 AC-17): POST,
 * `Content-Type: application/json`, `Origin` exactly the VRMS web address, and `Sec-Fetch-Site`
 * `same-origin` or `same-site` when the browser sends it.
 */
export function passesCsrf(request: Request, allowedOrigin: string): boolean {
  if (request.method !== 'POST') return false;
  // Read the header itself: `req.is()` answers null for a POST with no body
  const type = request.headers['content-type'];
  if (
    typeof type !== 'string' ||
    type.split(';')[0].trim().toLowerCase() !== 'application/json'
  ) {
    return false;
  }
  if (request.headers.origin !== allowedOrigin) return false;
  const site = request.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'same-site';
}

@Injectable()
export class SessionCsrfGuard implements CanActivate {
  constructor(@Inject(SESSION_CONFIG) private readonly config: SessionConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (passesCsrf(request, this.config.webAppOrigin)) return true;
    throw new HttpException(
      {
        statusCode: HttpStatus.FORBIDDEN,
        message: 'This request did not come from VRMS',
        error: 'Forbidden',
        code: 'CSRF_REJECTED',
      },
      HttpStatus.FORBIDDEN,
    );
  }
}
