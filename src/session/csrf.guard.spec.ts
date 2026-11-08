import { HttpException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { SessionCsrfGuard, passesCsrf } from './csrf.guard';
import type { SessionConfig } from './session.config';

const ORIGIN = 'http://localhost:8001';
const request = (
  over: Partial<{ method: string; headers: Record<string, string> }> = {},
) =>
  ({
    method: over.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(over.headers ?? {}),
    },
  }) as unknown as Request;

// covers: AC-17
describe('passesCsrf (AC-17)', () => {
  it('accepts a JSON POST from the exact web origin', () => {
    expect(passesCsrf(request(), ORIGIN)).toBe(true);
  });

  it('accepts a content type with a charset', () => {
    expect(
      passesCsrf(
        request({
          headers: { 'content-type': 'Application/JSON; charset=utf-8' },
        }),
        ORIGIN,
      ),
    ).toBe(true);
  });

  it.each(['GET', 'PUT', 'DELETE', 'OPTIONS'])('rejects %s', (method) => {
    expect(passesCsrf(request({ method }), ORIGIN)).toBe(false);
  });

  it('rejects a form content type and a missing content type', () => {
    expect(
      passesCsrf(
        request({
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
        ORIGIN,
      ),
    ).toBe(false);
    expect(
      passesCsrf(
        request({
          headers: { 'content-type': undefined as unknown as string },
        }),
        ORIGIN,
      ),
    ).toBe(false);
  });

  it.each([
    'http://evil.test',
    'http://localhost:8001.evil.test',
    'http://localhost:8001/',
    'null',
    '',
  ])('rejects origin %p', (origin) => {
    expect(passesCsrf(request({ headers: { origin } }), ORIGIN)).toBe(false);
  });

  it('rejects a missing Origin', () => {
    expect(
      passesCsrf(
        request({ headers: { origin: undefined as unknown as string } }),
        ORIGIN,
      ),
    ).toBe(false);
  });

  it('accepts Sec-Fetch-Site same-origin, same-site or not sent, rejects cross-site and none', () => {
    expect(
      passesCsrf(
        request({ headers: { 'sec-fetch-site': 'same-origin' } }),
        ORIGIN,
      ),
    ).toBe(true);
    expect(
      passesCsrf(
        request({ headers: { 'sec-fetch-site': 'same-site' } }),
        ORIGIN,
      ),
    ).toBe(true);
    expect(
      passesCsrf(
        request({ headers: { 'sec-fetch-site': 'cross-site' } }),
        ORIGIN,
      ),
    ).toBe(false);
    expect(
      passesCsrf(request({ headers: { 'sec-fetch-site': 'none' } }), ORIGIN),
    ).toBe(false);
  });
});

describe('SessionCsrfGuard', () => {
  const guard = new SessionCsrfGuard({ webAppOrigin: ORIGIN } as SessionConfig);
  const context = (req: Request) =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  it('lets a good request through', () => {
    expect(guard.canActivate(context(request()))).toBe(true);
  });

  it('answers 403 CSRF_REJECTED for a bad origin', () => {
    let error: HttpException | undefined;
    try {
      guard.canActivate(
        context(request({ headers: { origin: 'http://evil.test' } })),
      );
    } catch (e) {
      error = e as HttpException;
    }
    expect(error?.getStatus()).toBe(403);
    expect(error?.getResponse()).toMatchObject({ code: 'CSRF_REJECTED' });
  });
});
