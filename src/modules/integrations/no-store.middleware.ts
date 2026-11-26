import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Spec 0029, AC-24: every `/vrms/integrations/*` answer carries `Cache-Control: no-store`. Set
 * before the guards run, so a 401 or 403 refusal carries it too (a route `@Header` would not).
 */
@Injectable()
export class NoStoreMiddleware implements NestMiddleware {
  use(_request: Request, response: Response, next: NextFunction): void {
    response.setHeader('Cache-Control', 'no-store');
    next();
  }
}
