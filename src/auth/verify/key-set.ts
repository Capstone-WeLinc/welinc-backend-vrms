import {
  createLocalJWKSet,
  errors,
  type JSONWebKeySet,
  type JWSHeaderParameters,
  type FlattenedJWSInput,
  type CryptoKey,
} from 'jose';

/** Thrown when no usable key set is left, so the request answers 503, never 401 (AC-12). */
export class KeysUnavailableError extends Error {
  constructor() {
    super('welinc-auth signing keys are unavailable');
    this.name = 'KeysUnavailableError';
  }
}

export type KeySetOptions = {
  url: string;
  /** How long a fetched set is used before fetching again (AC-11: 5 minutes). */
  cacheMs?: number;
  /** The shortest gap between two fetches for an unknown `kid` (AC-11: 1 minute). */
  cooldownMs?: number;
  /** How long the last good set keeps working while fetches fail (AC-12: 1 hour). */
  maxStaleMs?: number;
  /** Time allowed for one fetch (AC-12: 3 seconds). */
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  /** Told why a fetch failed (never with key material), for a log line. */
  onFetchError?: (reason: string) => void;
};

type Local = ReturnType<typeof createLocalJWKSet>;

/**
 * welinc-auth's published keys, cached. jose's remote key set stops serving cached keys once its
 * cache expires, so this wraps it by hand: fetch, keep the last good set, and verify through
 * `createLocalJWKSet` (spec 0002, AC-11, AC-12). Pass `getKey` to `jwtVerify`.
 */
export class ResilientKeySet {
  private local: Local | null = null;
  private kids = new Set<string>();
  private lastSuccess = 0;
  private lastAttempt = 0;
  private lastAttemptFailed = false;
  private inFlight: Promise<boolean> | null = null;

  private readonly cacheMs: number;
  private readonly cooldownMs: number;
  private readonly maxStaleMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: KeySetOptions) {
    this.cacheMs = options.cacheMs ?? 5 * 60_000;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.maxStaleMs = options.maxStaleMs ?? 60 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** The `getKey` function for `jwtVerify`. */
  readonly getKey = async (
    header: JWSHeaderParameters,
    token: FlattenedJWSInput,
  ): Promise<CryptoKey> => {
    const now = this.now();

    // Refresh a set older than the cache time; a failure keeps the last good set
    if (!this.local || now - this.lastSuccess >= this.cacheMs) {
      if (this.mayAttempt(now)) await this.refresh();
    }
    if (!this.usable(this.now())) throw new KeysUnavailableError();

    // An unknown kid: fetch again, at most once a minute
    if (header.kid === undefined || !this.kids.has(header.kid)) {
      if (now - this.lastAttempt >= this.cooldownMs) await this.refresh();
      if (header.kid === undefined || !this.kids.has(header.kid)) {
        // Still unknown after a good fetch: a bad token (401). After a failed one: unknown (503)
        if (this.lastAttemptFailed) throw new KeysUnavailableError();
        throw new errors.JWKSNoMatchingKey();
      }
    }

    return this.local!(header, token);
  };

  private usable(now: number): boolean {
    return this.local !== null && now - this.lastSuccess <= this.maxStaleMs;
  }

  /** After a failed fetch, wait out the cooldown before trying again, so an outage isn't hammered. */
  private mayAttempt(now: number): boolean {
    return !this.lastAttemptFailed || now - this.lastAttempt >= this.cooldownMs;
  }

  /** One fetch at a time; callers who arrive meanwhile share it. True when it succeeded. */
  private refresh(): Promise<boolean> {
    if (!this.inFlight) {
      this.inFlight = this.fetchSet().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async fetchSet(): Promise<boolean> {
    this.lastAttempt = this.now();
    try {
      const res = await this.fetchFn(this.options.url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as JSONWebKeySet;
      if (!Array.isArray(body?.keys)) throw new Error('no keys list');
      const local = createLocalJWKSet(body);
      this.local = local;
      this.kids = new Set(
        body.keys.map((key) => key.kid).filter((kid): kid is string => !!kid),
      );
      this.lastSuccess = this.now();
      this.lastAttemptFailed = false;
      return true;
    } catch (error) {
      this.lastAttemptFailed = true;
      const name = (error as { name?: unknown } | null)?.name;
      const reason =
        error instanceof Error &&
        name !== 'TimeoutError' &&
        name !== 'AbortError'
          ? error.message
          : 'timeout';
      this.options.onFetchError?.(reason);
      return false;
    }
  }
}
