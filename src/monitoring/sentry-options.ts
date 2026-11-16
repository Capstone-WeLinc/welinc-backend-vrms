import type { ErrorEvent, EventHint, NodeOptions } from '@sentry/nestjs';
import type { SentrySettings } from '../config/env';
import { redact } from './redact';

// VRMS spec 0025: everything Sentry.init gets, kept apart from instrument.ts so it can be tested.

/** The `system` tag on every event from this app. */
export const SENTRY_SYSTEM = 'vrms';

/** An HttpException's status, duck typed so this file never loads @nestjs/common early. */
export function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { getStatus?: unknown } | null)?.getStatus;
  if (typeof status !== 'function') return undefined;
  const value: unknown = status.call(error);
  return typeof value === 'number' ? value : undefined;
}

/** The path of a request URL, absolute or relative, with no query string or fragment. */
function pathOf(url: string): string {
  const path = URL.canParse(url) ? new URL(url).pathname : url;
  return path.split(/[?#]/)[0];
}

/** AC-2: health answers (the 503 included) never create an issue. */
export function isHealthPath(url: string): boolean {
  return /\/health\/?$/.test(pathOf(url));
}

/** The request part of an event, rebuilt from an allowlist so a new field can't leak (AC-6). */
function allowedRequest(request: ErrorEvent['request']): ErrorEvent['request'] {
  if (!request) return undefined;
  const userAgent = request.headers?.['user-agent'];
  return {
    method: request.method,
    url: request.url ? redact(pathOfUrl(request.url)) : undefined,
    headers: userAgent ? { 'user-agent': userAgent } : {},
  };
}

/** Keeps the origin when there is one, drops the query string and fragment. */
function pathOfUrl(url: string): string {
  if (!URL.canParse(url)) return pathOf(url);
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

/**
 * AC-1, AC-2 and AC-6: drops expected answers (an HttpException below 500, anything on a health
 * path), keeps only the user id, and runs `redact()` over every text the event carries.
 */
export function beforeSend(
  event: ErrorEvent,
  hint: EventHint,
): ErrorEvent | null {
  const status = httpStatusOf(hint.originalException);
  if (status !== undefined && status < 500) return null;
  if (event.request?.url && isHealthPath(event.request.url)) return null;

  event.request = allowedRequest(event.request);
  event.user = event.user?.id ? { id: event.user.id } : undefined;
  if (event.message) event.message = redact(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redact(exception.value);
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = redact(crumb.message);
    delete crumb.data;
  }
  return event;
}

/** The Sentry.init options for a running app (spec 0025, Backend setup). */
export function sentryOptions(settings: SentrySettings): NodeOptions {
  return {
    dsn: settings.dsn,
    environment: settings.environment,
    release: settings.release,
    initialScope: { tags: { system: SENTRY_SYSTEM } },
    // No performance quota; an incoming sentry-trace header still links the browser's trace (AC-9)
    tracesSampleRate: 0,
    maxBreadcrumbs: 20,
    // AC-6: collect nothing personal; beforeSend's allowlist is the second line of defence
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ['user-agent'] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
    },
    beforeSend,
  };
}
