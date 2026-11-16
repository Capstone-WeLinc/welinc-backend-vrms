import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';
import { SentryExceptionFilter } from './sentry-exception.filter';
import { SentryTestController } from './sentry-test.controller';

/** VRMS spec 0025, AC-16: the test route exists only when the staging switch is on. */
@Module({ controllers: [SentryTestController] })
export class SentryTestModule {}

/**
 * VRMS spec 0025: Sentry's request scope and the catch all filter. Sentry itself starts in
 * src/instrument.ts; with no DSN both stay in place and send nothing (AC-14).
 */
@Module({
  imports: [
    SentryModule.forRoot(),
    ConditionalModule.registerWhen(
      SentryTestModule,
      (env) => env.SENTRY_TEST_ROUTES?.trim() === 'true',
    ),
  ],
  providers: [{ provide: APP_FILTER, useClass: SentryExceptionFilter }],
})
export class MonitoringModule {}
