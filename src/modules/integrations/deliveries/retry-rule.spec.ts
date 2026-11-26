import {
  errorFromBody,
  errorFromThrown,
  isRetryable,
  MAX_ERROR_LENGTH,
  nextState,
  waitAfter,
} from './retry-rule';

// covers: spec 0029 AC-21 (the retry rule of child 0004)

const start = new Date('2026-11-27T00:00:00Z');
const at = (ms: number) => new Date(start.getTime() + ms);
const HOUR = 3_600_000;

describe('waitAfter', () => {
  it('waits 30 s, then doubles, up to one hour', () => {
    expect([1, 2, 3, 4].map(waitAfter)).toEqual([
      30_000, 60_000, 120_000, 240_000,
    ]);
    expect(waitAfter(7)).toBe(1_920_000);
    expect(waitAfter(8)).toBe(HOUR);
    expect(waitAfter(500)).toBe(HOUR);
  });
});

describe('isRetryable', () => {
  it('retries 401, 403, 408, 429 and every 5xx, and nothing else', () => {
    expect([401, 403, 408, 429, 500, 502, 503, 599].every(isRetryable)).toBe(
      true,
    );
    expect([400, 404, 409, 410, 422].some(isRetryable)).toBe(false);
  });
});

describe('nextState', () => {
  const row = (attempts: number) => ({ attempts, firstAttemptAt: start });

  it('counts any 2xx as sent', () => {
    for (const status of [200, 201, 202, 204]) {
      expect(
        nextState({ kind: 'answer', status, error: null }, row(1), at(0), 24),
      ).toEqual({
        status: 'SENT',
        lastStatusCode: status,
      });
    }
  });

  it('retries 503 three times with 30, 60 and 120 s waits, keeping the code and error', () => {
    const answer = {
      kind: 'answer' as const,
      status: 503,
      error: 'UPSTREAM_DOWN',
    };
    expect(nextState(answer, row(1), at(0), 24)).toEqual({
      status: 'PENDING',
      nextAttemptAt: at(30_000),
      lastStatusCode: 503,
      lastError: 'UPSTREAM_DOWN',
    });
    expect(nextState(answer, row(2), at(30_000), 24)).toMatchObject({
      nextAttemptAt: at(90_000),
    });
    expect(nextState(answer, row(3), at(90_000), 24)).toMatchObject({
      nextAttemptAt: at(210_000),
    });
  });

  it('retries a network error or a timeout with no status code', () => {
    expect(
      nextState(
        { kind: 'no_answer', error: 'TimeoutError' },
        row(1),
        at(0),
        24,
      ),
    ).toMatchObject({
      status: 'PENDING',
      lastStatusCode: null,
      lastError: 'TimeoutError',
    });
  });

  it('fails at once on any other 4xx, keeping the other system’s code', () => {
    expect(
      nextState(
        { kind: 'answer', status: 409, error: 'EVENT_VERSION_CONFLICT' },
        row(1),
        at(0),
        24,
      ),
    ).toEqual({
      status: 'FAILED',
      lastStatusCode: 409,
      lastError: 'EVENT_VERSION_CONFLICT',
    });
  });

  it('fails a retryable answer once the window since the first attempt is over', () => {
    const answer = { kind: 'answer' as const, status: 502, error: null };
    expect(nextState(answer, row(30), at(24 * HOUR - 1), 24).status).toBe(
      'PENDING',
    );
    expect(nextState(answer, row(30), at(24 * HOUR), 24)).toEqual({
      status: 'FAILED',
      lastStatusCode: 502,
      lastError: 'HTTP 502',
    });
    // The window is the setting, not a constant
    expect(nextState(answer, row(3), at(2 * HOUR), 1).status).toBe('FAILED');
  });

  it('cuts a long error to 500 characters', () => {
    const update = nextState(
      { kind: 'answer', status: 400, error: 'x'.repeat(2000) },
      row(1),
      at(0),
      24,
    );
    expect(update.status === 'FAILED' && update.lastError.length).toBe(
      MAX_ERROR_LENGTH,
    );
  });
});

describe('errorFromBody and errorFromThrown', () => {
  it('reads code, then error, then the text', () => {
    expect(
      errorFromBody('{"code":"REPAIR_NOT_FOUND","error":"Not Found"}'),
    ).toBe('REPAIR_NOT_FOUND');
    expect(errorFromBody('{"error":"Bad Gateway"}')).toBe('Bad Gateway');
    expect(errorFromBody('<html>502</html>')).toBe('<html>502</html>');
    expect(errorFromBody('  ')).toBeNull();
  });

  it('names a network failure by its code, never its message', () => {
    const refused = new TypeError('fetch failed to http://vmms-backend:3010', {
      cause: { code: 'ECONNREFUSED' },
    });
    expect(errorFromThrown(refused)).toBe('ECONNREFUSED');
    expect(errorFromThrown(new DOMException('aborted', 'TimeoutError'))).toBe(
      'TimeoutError',
    );
    expect(errorFromThrown('nope')).toBe('UNKNOWN_ERROR');
  });
});
