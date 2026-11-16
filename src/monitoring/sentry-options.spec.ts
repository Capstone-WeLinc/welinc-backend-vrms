import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ErrorEvent } from '@sentry/nestjs';
import {
  beforeSend,
  isHealthPath,
  SENTRY_SYSTEM,
  sentryOptions,
} from './sentry-options';

// covers: VRMS spec 0025 AC-1, AC-2, AC-6

const event = (extra: Partial<ErrorEvent> = {}): ErrorEvent => ({
  type: undefined,
  request: {
    method: 'POST',
    url: 'https://api.welinc.test/vrms/repairs/1?email=a@b.co&code=123456',
    query_string: 'email=a@b.co&code=123456',
    cookies: { vrms_rt: 'secret' },
    data: { password: 'x' },
    headers: {
      'user-agent': 'Mozilla/5.0',
      authorization: 'Bearer eyJa.eyJb.c',
      cookie: 'vrms_rt=secret',
    },
  },
  ...extra,
});

describe('beforeSend', () => {
  it('drops an HttpException below 500', () => {
    expect(
      beforeSend(event(), { originalException: new BadRequestException() }),
    ).toBeNull();
  });

  it('keeps an HttpException of 500 or more', () => {
    expect(
      beforeSend(event(), {
        originalException: new ServiceUnavailableException(),
      }),
    ).not.toBeNull();
  });

  it('drops anything on a health path', () => {
    const health = event();
    health.request!.url = 'https://api.welinc.test/vrms/health';
    expect(
      beforeSend(health, { originalException: new Error('db down') }),
    ).toBeNull();
  });

  it('keeps only the method, the URL without its query, and the user agent', () => {
    const sent = beforeSend(event(), { originalException: new Error('x') });
    expect(sent?.request).toEqual({
      method: 'POST',
      url: 'https://api.welinc.test/vrms/repairs/1',
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
  });

  it('keeps only the user id', () => {
    const sent = beforeSend(
      event({
        user: {
          id: 'u1',
          email: 'a@b.co',
          ip_address: '1.2.3.4',
          username: 'a',
        },
      }),
      { originalException: new Error('x') },
    );
    expect(sent?.user).toEqual({ id: 'u1' });
  });

  it('redacts the message, exception values and breadcrumbs', () => {
    const sent = beforeSend(
      event({
        message: 'mail to a@b.co failed',
        exception: { values: [{ type: 'Error', value: 'Bearer abc refused' }] },
        breadcrumbs: [
          { message: 'GET /x?email=a@b.co', data: { url: '/x?code=1' } },
        ],
      }),
      { originalException: new Error('x') },
    );
    expect(sent?.message).toBe('mail to [email] failed');
    expect(sent?.exception?.values?.[0].value).toBe('Bearer [token] refused');
    expect(sent?.breadcrumbs?.[0]).toEqual({ message: 'GET /x?email=[email]' });
  });
});

describe('isHealthPath', () => {
  it.each([
    ['/vrms/health', true],
    ['https://api.welinc.test/vrms/health?x=1', true],
    ['/health/', true],
    ['/vrms/healthy', false],
    ['/vrms/repairs', false],
  ])('%s → %s', (url, expected) => {
    expect(isHealthPath(url)).toBe(expected);
  });
});

describe('sentryOptions', () => {
  it('tags the system, samples no traces and collects nothing personal', () => {
    const options = sentryOptions({
      dsn: 'https://k@o1.ingest.us.sentry.io/2',
      environment: 'staging',
      release: 'abc',
    });
    expect(options).toMatchObject({
      environment: 'staging',
      release: 'abc',
      initialScope: { tags: { system: SENTRY_SYSTEM } },
      tracesSampleRate: 0,
      maxBreadcrumbs: 20,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpBodies: [],
        urlQueryParams: false,
      },
    });
  });
});
