import { ArgumentsHost, Catch } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import type { Request } from 'express';
import { httpStatusOf, isHealthPath } from './sentry-options';

/**
 * VRMS spec 0025, AC-1: Sentry's own filter treats every HttpException as expected, the 5xx ones
 * included (503 `AUTH_UNAVAILABLE`, `STORAGE_UNAVAILABLE`, `AI_UNAVAILABLE`). This reports those,
 * outside the health routes, then hands over to it. Anything else it already reports itself.
 */
@Catch()
export class SentryExceptionFilter extends SentryGlobalFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const status = httpStatusOf(exception);
    if (status !== undefined && status >= 500 && host.getType() === 'http') {
      const request = host.switchToHttp().getRequest<Request>();
      if (!isHealthPath(request.originalUrl ?? request.url)) {
        Sentry.captureException(exception, {
          mechanism: { handled: false, type: 'auto.http.nestjs.vrms_filter' },
        });
      }
    }
    super.catch(exception, host);
  }
}
