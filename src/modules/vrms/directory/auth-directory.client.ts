import {
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService as EnvConfig } from '@nestjs/config';
import type { Env } from '../../../config/env';
import { authInternalUrl } from '../../../auth/account-check';
import { DIRECTORY_TOKENS, ServiceTokenClient } from '../../../auth/verify';

/** A person as welinc-auth's directory answers them (contract 0001 section 9, spec 0005 AC-7). */
export type DirectoryUser = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  picture: string | null;
  isActive: boolean;
  deleted: boolean;
  /** Contract 0001 version 6 (suite spec 0012): the person's data was erased in welinc-auth. */
  erased: boolean;
  /** Role codes in VRMS only. */
  roles: string[];
  /**
   * Suite spec 0013, AC-11: the codes in `roles` that are a suite admin's temporary access. Left
   * out by a welinc-auth from before contract version 7, which reads as none.
   */
  temporaryRoles?: string[];
  updatedAt: string;
};

/**
 * The roles that count for VRMS work: every role but a suite admin's temporary access, which never
 * makes anyone a pickable mechanic (suite spec 0013, AC-11).
 */
export function permanentRoles(
  user: Pick<DirectoryUser, 'roles' | 'temporaryRoles'>,
): string[] {
  const temporary = new Set(user.temporaryRoles ?? []);
  return user.roles.filter((role) => !temporary.has(role));
}

export type DirectoryChange = {
  cursor: string;
  type: string;
  at: string;
  user: DirectoryUser;
};

export type UsersPage = {
  users: DirectoryUser[];
  next: string | null;
  changesCursor: string;
};

export type ChangesPage = {
  changes: DirectoryChange[];
  next: string;
  hasMore: boolean;
};

export type LookupAnswer = { users: DirectoryUser[]; missing: string[] };

/** welinc-auth answered 400 `INVALID_CURSOR`: the stored cursor is no good, read everything again. */
export class DirectoryCursorError extends Error {
  constructor() {
    super('welinc-auth refused the directory cursor');
    this.name = 'DirectoryCursorError';
  }
}

/** No usable answer from welinc-auth: no answer, 5xx, 429, a refusal or an unreadable body. */
export class DirectoryUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`welinc-auth directory unavailable: ${reason}`);
    this.name = 'DirectoryUnavailableError';
  }
}

export const DIRECTORY_TIMEOUT_MS = 5_000;
/** Users per page on the full read. */
export const USERS_PAGE_SIZE = 500;
/** Changes per page on the feed. */
export const CHANGES_PAGE_SIZE = 100;

const isString = (v: unknown): v is string => typeof v === 'string';
const isNullableString = (v: unknown) => v === null || typeof v === 'string';

function readUser(raw: unknown): DirectoryUser | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const ok =
    isString(u.id) &&
    isString(u.name) &&
    isString(u.email) &&
    isNullableString(u.phone) &&
    isNullableString(u.picture) &&
    typeof u.isActive === 'boolean' &&
    typeof u.deleted === 'boolean' &&
    Array.isArray(u.roles) &&
    u.roles.every(isString) &&
    (u.temporaryRoles === undefined ||
      (Array.isArray(u.temporaryRoles) && u.temporaryRoles.every(isString))) &&
    isString(u.updatedAt);
  return ok ? (u as unknown as DirectoryUser) : null;
}

function readUsers(raw: unknown): DirectoryUser[] | null {
  if (!Array.isArray(raw)) return null;
  const users = raw.map(readUser);
  return users.every((u) => u !== null) ? users : null;
}

/** Throws `DirectoryUnavailableError` when welinc-auth's body isn't what the contract says. */
function unreadable(): never {
  throw new DirectoryUnavailableError('unreadable answer');
}

/**
 * VRMS's reader of welinc-auth's user directory (spec 0005), always with VRMS's own service
 * token (`directory.read`). Other groups can copy this file for S11.
 */
@Injectable()
export class AuthDirectoryClient {
  private readonly base: string;

  constructor(
    env: EnvConfig<Env, true>,
    @Inject(DIRECTORY_TOKENS) private readonly tokens: ServiceTokenClient,
  ) {
    this.base = `${authInternalUrl(env)}/auth/directory`;
  }

  async listUsers(cursor: string | null): Promise<UsersPage> {
    const query = new URLSearchParams({ limit: String(USERS_PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const body = (await this.call('GET', `/users?${query}`)) as Record<
      string,
      unknown
    >;
    const users = readUsers(body?.users);
    if (
      !users ||
      !isNullableString(body.next) ||
      !isString(body.changesCursor)
    ) {
      unreadable();
    }
    return {
      users,
      next: body.next,
      changesCursor: body.changesCursor,
    };
  }

  async changes(after: string | null): Promise<ChangesPage> {
    const query = new URLSearchParams({ limit: String(CHANGES_PAGE_SIZE) });
    if (after) query.set('after', after);
    const body = (await this.call('GET', `/changes?${query}`)) as Record<
      string,
      unknown
    >;
    if (
      !body ||
      !Array.isArray(body.changes) ||
      !isString(body.next) ||
      typeof body.hasMore !== 'boolean'
    ) {
      unreadable();
    }
    const changes: DirectoryChange[] = [];
    for (const raw of body.changes as unknown[]) {
      const c = raw as Record<string, unknown> | null;
      const user = readUser(c?.user);
      if (!c || !user || !isString(c.cursor) || !isString(c.type)) unreadable();
      changes.push({
        cursor: c.cursor,
        type: c.type,
        at: String(c.at),
        user,
      });
    }
    return {
      changes,
      next: body.next,
      hasMore: body.hasMore,
    };
  }

  async lookup(ids: string[]): Promise<LookupAnswer> {
    const body = (await this.call('POST', '/users/lookup', { ids })) as Record<
      string,
      unknown
    >;
    const users = readUsers(body?.users);
    if (
      !users ||
      !Array.isArray(body.missing) ||
      !body.missing.every(isString)
    ) {
      unreadable();
    }
    return { users, missing: body.missing };
  }

  /**
   * One call with the service token. A 401 is thrown as `UnauthorizedException` so the token
   * client fetches a new token and tries once more; a second 401 becomes unavailable.
   */
  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    try {
      return await this.tokens.withToken((token) =>
        this.send(method, path, token, body),
      );
    } catch (error) {
      if (
        error instanceof DirectoryCursorError ||
        error instanceof DirectoryUnavailableError
      ) {
        throw error;
      }
      if (error instanceof HttpException) {
        // The token client's own 503, or a 401 that survived the retry
        throw new DirectoryUnavailableError(`status ${error.getStatus()}`);
      }
      throw error;
    }
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: unknown,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
      });
    } catch (error) {
      // A timeout is a DOMException, which is not always an Error instance
      const name = (error as { name?: unknown } | null)?.name;
      throw new DirectoryUnavailableError(
        typeof name === 'string' ? name : 'network error',
      );
    }

    if (res.status === 401) throw new UnauthorizedException();
    let answer: unknown = null;
    try {
      answer = await res.json();
    } catch {
      if (res.status === 200) unreadable();
    }
    if (res.status === 200) return answer;
    const code = (answer as { code?: unknown } | null)?.code;
    if (res.status === 400 && code === 'INVALID_CURSOR') {
      throw new DirectoryCursorError();
    }
    throw new DirectoryUnavailableError(
      `status ${res.status}${isString(code) ? ` ${code}` : ''}`,
    );
  }
}
