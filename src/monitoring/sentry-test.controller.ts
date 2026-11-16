import { Controller, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { RequirePermission } from '../auth/permissions/permission.decorators';

/**
 * VRMS spec 0025, AC-16: `POST /vrms/debug/sentry-test` throws so an admin can see an issue arrive.
 * Registered only when SENTRY_TEST_ROUTES is true (staging), so it answers 404 everywhere else,
 * and kept out of the API docs (spec 0026, AC-7).
 */
@ApiExcludeController()
@Controller('vrms/debug')
export class SentryTestController {
  @Post('sentry-test')
  @RequirePermission('settings.manage')
  sentryTest(): never {
    throw new Error('Sentry test error from backend-vrms (spec 0025)');
  }
}
