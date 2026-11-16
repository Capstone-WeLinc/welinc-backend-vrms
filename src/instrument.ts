// VRMS spec 0025: Sentry starts here, before Nest loads, so its Express and Nest hooks can attach.
// main.ts imports this file first. With no SENTRY_DSN (or no valid SENTRY_ENVIRONMENT) nothing
// starts and nothing is sent (AC-14); the boot check then reports any half set pair (AC-15).
import * as Sentry from '@sentry/nestjs';
import { sentrySettings } from './config/env';
import { sentryOptions } from './monitoring/sentry-options';

const settings = sentrySettings();
if (settings) Sentry.init(sentryOptions(settings));
