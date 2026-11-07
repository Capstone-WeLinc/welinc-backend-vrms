import { authUnavailable } from './errors';
import type { AssertionSigner } from './assertion-signer';

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** A token is dropped this long before it expires, so a call never starts with a dying one. */
export const REFRESH_EARLY_MS = 60_000;

export type ServiceTokenOptions = {
  /** `<AUTH_INTERNAL_URL>/auth/token`. */
  tokenUrl: string;
  signer: AssertionSigner;
  audience: string;
  scope: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  /** Told why a token request failed (the OAuth error code or a network reason, never a secret). */
  onError?: (reason: string) => void;
};

/** True for an error that carries HTTP 401, as Nest's `HttpException` does. */
function isUnauthorized(error: unknown): boolean {
  const status = (error as { getStatus?: () => number } | null)?.getStatus?.();
  return status === 401;
}

/**
 * This service's own token for one audience and scope, from the client credentials grant (spec
 * 0002, AC-20). In memory, one per process: kept until 60 s before it expires, and callers who
 * need it at the same moment share one request.
 */
export class ServiceTokenClient {
  private cached: { token: string; expiresAt: number } | null = null;
  private inFlight: Promise<string> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ServiceTokenOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** The current token, fetching one when none is kept. Throws 503 `AUTH_UNAVAILABLE` on failure. */
  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - REFRESH_EARLY_MS > this.now()) {
      return this.cached.token;
    }
    if (!this.inFlight) {
      this.inFlight = this.request().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Forgets the kept token, so the next call fetches a fresh one. */
  drop(): void {
    this.cached = null;
  }

  /**
   * Runs `call` with the token. When it fails with 401 (welinc-auth no longer accepts the kept
   * token, say after a key change), drops the token, gets a new one and runs `call` once more.
   * A 403 or anything else is never retried.
   */
  async withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    const first = await this.token();
    try {
      return await call(first);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      if (this.cached?.token === first) this.drop();
      return call(await this.token());
    }
  }

  private async request(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: await this.options.signer.sign(),
      client_id: this.options.signer.clientId,
      audience: this.options.audience,
      scope: this.options.scope,
    });
    let res: Response;
    try {
      res = await this.fetchFn(this.options.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 3_000),
      });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      this.options.onError?.(typeof name === 'string' ? name : 'network error');
      throw authUnavailable();
    }

    let answer: {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
    } = {};
    try {
      answer = (await res.json()) as typeof answer;
    } catch {
      // handled below
    }
    if (
      res.status !== 200 ||
      typeof answer.access_token !== 'string' ||
      typeof answer.expires_in !== 'number'
    ) {
      this.options.onError?.(
        typeof answer.error === 'string'
          ? `${res.status} ${answer.error}`
          : `status ${res.status}`,
      );
      throw authUnavailable();
    }
    this.cached = {
      token: answer.access_token,
      expiresAt: this.now() + answer.expires_in * 1000,
    };
    return answer.access_token;
  }
}
