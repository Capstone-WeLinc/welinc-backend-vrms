import {
  HttpException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService as EnvConfig } from '@nestjs/config';
import type { Env } from '../../../config/env';
import { authInternalUrl } from '../../account-check';
import { PERMISSIONS_TOKENS, ServiceTokenClient } from '../../verify';
import { isAuthMatrix, type AuthMatrix } from './matrix-rows';

export const PERMISSIONS_TIMEOUT_MS = 5_000;

/** Anything but a usable answer: welinc-auth down, a refusal, or a body we can't read. */
export class PermissionsUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`welinc-auth's permission matrix is unavailable: ${reason}`);
    this.name = 'PermissionsUnavailableError';
  }
}

export type MatrixAnswer =
  | { kind: 'unchanged' }
  | { kind: 'changed'; etag: string; matrix: AuthMatrix };

/**
 * Suite spec 0013, AC-29: VRMS's reader of `GET /auth/permissions/VRMS`, with its own service
 * token (`permissions.read`) and `If-None-Match`, so an unchanged matrix costs a 304.
 */
@Injectable()
export class AuthPermissionsClient {
  private readonly url: string;

  constructor(
    env: EnvConfig<Env, true>,
    @Inject(PERMISSIONS_TOKENS) private readonly tokens: ServiceTokenClient,
  ) {
    this.url = `${authInternalUrl(env)}/auth/permissions/VRMS`;
  }

  async read(etag: string | null): Promise<MatrixAnswer> {
    try {
      return await this.tokens.withToken((token) => this.send(token, etag));
    } catch (error) {
      if (error instanceof PermissionsUnavailableError) throw error;
      if (error instanceof HttpException) {
        // The token client's own 503, or a 401 that survived the retry
        throw new PermissionsUnavailableError(`status ${error.getStatus()}`);
      }
      throw error;
    }
  }

  private async send(
    token: string,
    etag: string | null,
  ): Promise<MatrixAnswer> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
        signal: AbortSignal.timeout(PERMISSIONS_TIMEOUT_MS),
      });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      throw new PermissionsUnavailableError(
        typeof name === 'string' ? name : 'network error',
      );
    }
    // A 401 lets the token client fetch a new token and try once more
    if (res.status === 401) throw new UnauthorizedException();
    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status !== 200) {
      let code = '';
      try {
        const body = (await res.json()) as { code?: unknown };
        if (typeof body.code === 'string') code = ` ${body.code}`;
      } catch {
        // no body to read
      }
      throw new PermissionsUnavailableError(`status ${res.status}${code}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new PermissionsUnavailableError('unreadable answer');
    }
    const tag = res.headers.get('etag');
    if (!tag || !isAuthMatrix(body)) {
      throw new PermissionsUnavailableError('unreadable answer');
    }
    return { kind: 'changed', etag: tag, matrix: body };
  }
}
