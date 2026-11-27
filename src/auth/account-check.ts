import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { SystemType, RoleCode } from './roles';
import {
  AUTH_UNAVAILABLE_MESSAGE,
  sessionEnded,
  tokenExpired,
  type UserToken,
} from './verify';

// Spec 0009 AC-4 to AC-7, spec 0003 AC-26: every protected request confirms the caller's session
// with welinc-auth, cached by sid for 30 seconds or until the token expires.
export const CHECK_TIMEOUT_MS = 3_000;
export const CACHE_TTL_MS = 30_000;
export const CACHE_MAX_ENTRIES = 5_000;

export const UNAVAILABLE = AUTH_UNAVAILABLE_MESSAGE;
const NO_ACCESS = 'User does not have access to this system';

/** The caller as VRMS sees it: name from `/auth/session`, roles from the checked token. */
export type AuthUser = {
  sub: string;
  email: string;
  name: string;
  system: typeof SystemType.VRMS;
  roles: { role: RoleCode; system: string }[];
};

/** A confirmed caller; `fresh` is true when welinc-auth was asked on this request. */
export type Confirmed = { user: AuthUser; fresh: boolean };

/**
 * welinc-auth's address on the internal network (`AUTH_INTERNAL_URL`, spec 0002, AC-22), without a
 * trailing slash. The boot check (spec 0010) refuses to start without it.
 */
export function authInternalUrl(config: ConfigService<Env, true>): string {
  return config.get('AUTH_INTERNAL_URL', { infer: true }).replace(/\/+$/, '');
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

/** What `/auth/session` said about one `sid`, kept for at most 30 s (spec 0003, AC-26). */
type SessionAnswer =
  | {
      kind: 'live';
      userId: string;
      name: string;
      email: string;
      sessionExpiresAt: string;
      until: number;
    }
  | { kind: 'ended'; code: string; message: string; until: number };

const ENDED_CODES = new Set([
  'SESSION_ENDED',
  'ACCOUNT_INACTIVE',
  'ACCOUNT_LOCKED',
]);

/**
 * The session check of spec 0001 section 6 (spec 0003, AC-26): every request with a user token
 * asks welinc-auth's `GET /auth/session`, cached by `sid` for at most 30 s, failing closed.
 * An ended answer is cached until the token's own `exp`. Concurrent misses for one `sid` share
 * one call. The name comes from welinc-auth's answer, the roles from the checked token.
 */
@Injectable()
export class AccountCheck {
  private readonly logger = new Logger(AccountCheck.name);
  private readonly sessionUrl: string;
  private readonly cache = new Map<string, SessionAnswer>();
  private readonly inFlight = new Map<string, Promise<SessionAnswer>>();
  private readonly onConfirmed: ((user: AuthUser) => Promise<void>)[] = [];

  constructor(config: ConfigService<Env, true>) {
    this.sessionUrl = `${authInternalUrl(config)}/auth/session`;
  }

  /**
   * Runs `listener` after each answer welinc-auth gives (a cache miss), before the request goes on.
   * The just in time Mechanic row uses it (AC-13). A listener must not throw.
   */
  whenConfirmed(listener: (user: AuthUser) => Promise<void>) {
    this.onConfirmed.push(listener);
  }

  /** Confirms the caller's session (cached), and builds the caller VRMS sees. */
  async confirm(raw: string, token: UserToken): Promise<Confirmed> {
    const sid = this.sidOf(token);
    const cached = this.fromCache(sid);
    const answer = cached ?? (await this.ask(sid, raw, token.exp));
    const user = this.toUser(answer, token);
    if (!cached) {
      for (const listener of this.onConfirmed) await listener(user);
    }
    return { user, fresh: !cached };
  }

  /** `GET /vrms/session/status`: always asks welinc-auth, and refreshes the cache (AC-26). */
  async status(
    raw: string,
    token: UserToken,
  ): Promise<{ sessionExpiresAt: string }> {
    const sid = this.sidOf(token);
    this.cache.delete(sid);
    const answer = await this.ask(sid, raw, token.exp);
    this.toUser(answer, token);
    return {
      sessionExpiresAt: (answer as { sessionExpiresAt: string })
        .sessionExpiresAt,
    };
  }

  /** Drops what is cached for a session, after VRMS ended it itself (logout). */
  forget(sid: string) {
    this.cache.delete(sid);
  }

  private sidOf(token: UserToken): string {
    // AC-1: the S2 interim token, with no sid, works nowhere
    if (!token.sid) throw sessionEnded();
    return token.sid;
  }

  private fromCache(sid: string): SessionAnswer | null {
    const cached = this.cache.get(sid);
    if (!cached) return null;
    if (cached.until > Date.now()) return cached;
    this.cache.delete(sid);
    return null;
  }

  private toUser(answer: SessionAnswer, token: UserToken): AuthUser {
    if (answer.kind === 'ended') {
      throw sessionEnded(answer.message, answer.code);
    }
    if (answer.userId !== token.sub) throw sessionEnded();
    const roles = token.roles
      .filter((r) => r.system === SystemType.VRMS)
      .map((r) => ({ role: r.role, system: r.system }));
    if (roles.length === 0) throw new UnauthorizedException(NO_ACCESS);
    return {
      sub: token.sub,
      email: answer.email,
      name: answer.name,
      system: SystemType.VRMS,
      roles,
    };
  }

  private ask(sid: string, raw: string, exp: number): Promise<SessionAnswer> {
    const pending = this.inFlight.get(sid);
    if (pending) return pending;
    const call = this.call(raw, exp).then((answer) => {
      this.remember(sid, answer);
      return answer;
    });
    this.inFlight.set(sid, call);
    const clear = () => {
      this.inFlight.delete(sid);
    };
    call.then(clear, clear);
    return call;
  }

  private async call(raw: string, exp: number): Promise<SessionAnswer> {
    let res: Response;
    try {
      res = await fetch(this.sessionUrl, {
        headers: { Authorization: `Bearer ${raw}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch (err) {
      // A timeout is a DOMException, which is not always an Error instance
      const name = (err as { name?: unknown } | null)?.name;
      this.logger.warn(
        `welinc-auth did not answer: ${typeof name === 'string' ? name : 'unknown error'}`,
      );
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
    const body = await readBody(res);
    const tokenEnd = exp * 1000;
    if (res.status === 401) {
      const code = typeof body?.code === 'string' ? body.code : '';
      if (code === 'TOKEN_EXPIRED') throw tokenExpired();
      return {
        kind: 'ended',
        code: ENDED_CODES.has(code) ? code : 'SESSION_ENDED',
        message:
          typeof body?.message === 'string'
            ? body.message
            : 'The session has ended',
        until: tokenEnd,
      };
    }
    const user = body?.user as
      { id?: unknown; name?: unknown; email?: unknown } | undefined;
    if (
      res.status !== 200 ||
      body?.active !== true ||
      typeof body.expiresAt !== 'string' ||
      typeof user?.id !== 'string' ||
      typeof user.name !== 'string' ||
      typeof user.email !== 'string'
    ) {
      this.logger.warn(
        `welinc-auth answered ${res.status} to the session check`,
      );
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
    return {
      kind: 'live',
      userId: user.id,
      name: user.name,
      email: user.email,
      sessionExpiresAt: body.expiresAt,
      until: Math.min(Date.now() + CACHE_TTL_MS, tokenEnd),
    };
  }

  private remember(sid: string, answer: SessionAnswer) {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // A Map keeps insertion order, so the first key is the oldest
      const [oldest] = this.cache.keys();
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(sid, answer);
  }
}

async function readBody(
  res: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
