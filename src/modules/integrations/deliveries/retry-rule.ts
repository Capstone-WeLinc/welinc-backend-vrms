// Spec 0029 (child 0004), AC-21: what one send's answer means for its Delivery row. Pure, so the
// rule is tested without a database or a network. It matches VMMS's built sender (30 s doubling,
// 1 hour cap, 24 hour window), so both groups explain one rule.

export const FIRST_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 60 * 60 * 1000;
/** A claimed row is leased this long, so a crashed worker's rows come back. */
export const LEASE_MS = 60_000;
/** Each send gives up after this long and counts as a timeout. */
export const SEND_TIMEOUT_MS = 5_000;
/** Written at claim time; a real answer overwrites it, so it stays only when a send never ended. */
export const LEASE_EXPIRED = 'lease_expired';
export const MAX_ERROR_LENGTH = 500;

/** How one send ended: an HTTP answer, or no answer at all (network, timeout, no token). */
export type SendOutcome =
  | { kind: 'answer'; status: number; error: string | null }
  | { kind: 'no_answer'; error: string };

export type RowUpdate =
  | { status: 'SENT'; lastStatusCode: number }
  | {
      status: 'PENDING';
      nextAttemptAt: Date;
      lastStatusCode: number | null;
      lastError: string;
    }
  | { status: 'FAILED'; lastStatusCode: number | null; lastError: string };

const RETRYABLE = new Set([401, 403, 408, 429]);

/** 401 and 403 retry too: on a new setup they usually mean a grant or key still being fixed. */
export function isRetryable(status: number): boolean {
  return RETRYABLE.has(status) || status >= 500;
}

/** The wait after the n-th attempt (1 based): 30 s, 60 s, 120 s … up to 1 hour. */
export function waitAfter(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  // 2^7 × 30 s already passes the cap; stop before the number grows without need
  if (exponent >= 7) return MAX_WAIT_MS;
  return Math.min(FIRST_WAIT_MS * 2 ** exponent, MAX_WAIT_MS);
}

export function clipError(error: string): string {
  return error.length > MAX_ERROR_LENGTH
    ? error.slice(0, MAX_ERROR_LENGTH)
    : error;
}

/**
 * The row's next state. `attempts` already counts this send (the worker counts it at claim
 * time), and `firstAttemptAt` is set.
 */
export function nextState(
  outcome: SendOutcome,
  row: { attempts: number; firstAttemptAt: Date },
  now: Date,
  windowHours: number,
): RowUpdate {
  if (
    outcome.kind === 'answer' &&
    outcome.status >= 200 &&
    outcome.status < 300
  ) {
    return { status: 'SENT', lastStatusCode: outcome.status };
  }
  const lastStatusCode = outcome.kind === 'answer' ? outcome.status : null;
  const lastError = clipError(
    outcome.error ??
      (outcome.kind === 'answer' ? `HTTP ${outcome.status}` : ''),
  );
  const retryable = outcome.kind === 'no_answer' || isRetryable(outcome.status);
  const windowOver =
    now.getTime() - row.firstAttemptAt.getTime() >= windowHours * 3_600_000;
  if (!retryable || windowOver) {
    return { status: 'FAILED', lastStatusCode, lastError };
  }
  return {
    status: 'PENDING',
    nextAttemptAt: new Date(now.getTime() + waitAfter(row.attempts)),
    lastStatusCode,
    lastError,
  };
}

/** The other system's error code from its answer body (`code`, else `error`), or null. */
export function errorFromBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown };
    if (typeof parsed?.code === 'string') return parsed.code;
    if (typeof parsed?.error === 'string') return parsed.error;
  } catch {
    // Not JSON: fall through
  }
  const text = body.trim();
  return text ? text : null;
}

/** A network failure's name, never its message (which can hold an address). */
export function errorFromThrown(error: unknown): string {
  // Not only `Error`: a fetch timeout throws a DOMException, which isn't one everywhere
  if (error && typeof error === 'object') {
    const thrown = error as {
      name?: unknown;
      cause?: { code?: unknown };
      getResponse?: () => unknown;
    };
    if (typeof thrown.cause?.code === 'string') return thrown.cause.code;
    const bodyCode = (thrown.getResponse?.() as { code?: unknown } | undefined)
      ?.code;
    if (typeof bodyCode === 'string') return bodyCode;
    if (typeof thrown.name === 'string') return thrown.name;
  }
  return 'UNKNOWN_ERROR';
}
