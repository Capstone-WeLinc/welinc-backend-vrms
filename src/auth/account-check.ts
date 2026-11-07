import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { SystemType, UserRole } from './roles';
import { AUTH_UNAVAILABLE_MESSAGE } from './verify';

// Spec 0009, AC-4 to AC-7 and AC-25: every protected request confirms the caller with
// welinc-auth. Only 200 answers are cached, per token hash, for 30 seconds or until the
// token expires, whichever comes first.
export const CHECK_TIMEOUT_MS = 3_000;
export const CACHE_TTL_MS = 30_000;
export const CACHE_MAX_ENTRIES = 5_000;

export const UNAVAILABLE = AUTH_UNAVAILABLE_MESSAGE;
const NO_ACCESS = 'User does not have access to this system';

/** The caller as VRMS sees it, built from welinc-auth's `/auth/me` answer. */
export type AuthUser = {
  sub: string;
  email: string;
  name: string;
  system: typeof SystemType.VRMS;
  roles: { role: UserRole; system: string }[];
};

/** A confirmed caller; `fresh` is true when welinc-auth was asked on this request. */
export type Confirmed = { user: AuthUser; fresh: boolean };

type MeAnswer = {
  id?: unknown;
  email?: unknown;
  name?: unknown;
  roles?: unknown;
};

/**
 * welinc-auth's address on the internal network (`AUTH_INTERNAL_URL`, spec 0002, AC-22). Throws
 * when unset, so backend-vrms refuses to start (spec 0009, AC-4).
 */
export function authInternalUrl(config: ConfigService): string {
  return config.getOrThrow<string>('AUTH_INTERNAL_URL').replace(/\/+$/, '');
}

/**
 * GETs a welinc-auth route as the caller, sending only their own Authorization header (no Origin
 * or Referer), and maps the answer per AC-25: 401 and 403 pass through with welinc-auth's message,
 * and no answer in 3 seconds, any other status or an unreadable body is a 503.
 */
export async function askAuth(
  url: string,
  token: string,
  logger: Logger,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout is a DOMException, which is not always an Error instance
    const name = (err as { name?: unknown } | null)?.name;
    logger.warn(
      `welinc-auth did not answer: ${typeof name === 'string' ? name : 'unknown error'}`,
    );
    throw new ServiceUnavailableException(UNAVAILABLE);
  }

  if (res.status === 401 || res.status === 403) {
    const message = await readMessage(res);
    throw res.status === 401
      ? new UnauthorizedException(message ?? 'Invalid session')
      : new ForbiddenException(message ?? 'Forbidden');
  }

  if (res.status !== 200) {
    logger.warn(`welinc-auth answered ${res.status}`);
    throw new ServiceUnavailableException(UNAVAILABLE);
  }

  try {
    return (await res.json()) as unknown;
  } catch {
    logger.warn('welinc-auth answered 200 with a body VRMS cannot read');
    throw new ServiceUnavailableException(UNAVAILABLE);
  }
}

@Injectable()
export class AccountCheck {
  private readonly logger = new Logger(AccountCheck.name);
  private readonly meUrl: string;
  private readonly cache = new Map<
    string,
    { user: AuthUser; expiresAt: number }
  >();
  private readonly inFlight = new Map<string, Promise<AuthUser>>();
  private readonly onConfirmed: ((user: AuthUser) => Promise<void>)[] = [];

  constructor(config: ConfigService) {
    this.meUrl = `${authInternalUrl(config)}/auth/me?system=${SystemType.VRMS}`;
  }

  /**
   * Runs `listener` after each answer welinc-auth gives (a cache miss), before the request goes on.
   * The just in time Mechanic row uses it (AC-13). A listener must not throw.
   */
  whenConfirmed(listener: (user: AuthUser) => Promise<void>) {
    this.onConfirmed.push(listener);
  }

  /** `exp` is the token's own expiry claim, in seconds. */
  async confirm(token: string, exp?: number): Promise<Confirmed> {
    const key = createHash('sha256').update(token).digest('hex');
    const now = Date.now();

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return { user: cached.user, fresh: false };
    }
    if (cached) this.cache.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return { user: await pending, fresh: false };

    const call = this.ask(token);
    this.inFlight.set(key, call);
    try {
      const user = await call;
      const tokenEnd = exp ? exp * 1000 : Infinity;
      this.remember(key, user, Math.min(Date.now() + CACHE_TTL_MS, tokenEnd));
      return { user, fresh: true };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private remember(key: string, user: AuthUser, expiresAt: number) {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // A Map keeps insertion order, so the first key is the oldest
      const [oldest] = this.cache.keys();
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { user, expiresAt });
  }

  private async ask(token: string): Promise<AuthUser> {
    const body = await askAuth(this.meUrl, token, this.logger);
    const user = toAuthUser(body);
    if (!user) {
      this.logger.warn('welinc-auth answered 200 with a body VRMS cannot read');
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
    if (user.roles.length === 0) {
      throw new UnauthorizedException(NO_ACCESS);
    }
    for (const listener of this.onConfirmed) await listener(user);
    return user;
  }
}

function toAuthUser(body: unknown): AuthUser | null {
  if (typeof body !== 'object' || body === null) return null;
  const { id, email, name, roles } = body as MeAnswer;
  if (
    typeof id !== 'string' ||
    typeof email !== 'string' ||
    typeof name !== 'string' ||
    !Array.isArray(roles)
  ) {
    return null;
  }
  const vrmsRoles = roles
    .filter(
      (r): r is { role: UserRole; system: string } =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as { role?: unknown }).role === 'string' &&
        (r as { system?: unknown }).system === SystemType.VRMS,
    )
    .map((r) => ({ role: r.role, system: r.system }));
  return {
    sub: id,
    email,
    name,
    system: SystemType.VRMS,
    roles: vrmsRoles,
  };
}

async function readMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message) && typeof body.message[0] === 'string') {
      return body.message[0];
    }
  } catch {
    // fall back to the default message
  }
  return undefined;
}
