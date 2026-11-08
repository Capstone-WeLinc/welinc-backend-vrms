import { Inject, Injectable, Logger } from '@nestjs/common';
import { ASSERTION_SIGNER, type AssertionSigner } from '../auth/verify';
import { SESSION_CONFIG, type SessionConfig } from './session.config';

/** welinc-auth gets 3 s to answer, then VRMS treats it as unavailable (spec 0003, AC-16a). */
export const AUTH_CALL_TIMEOUT_MS = 3_000;

/** The user grants answer of `/auth/token` (spec 0001 section 5, spec 0003). */
export type UserGrant = {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  sid: string;
  sessionExpiresAt: string;
  /** The web session's absolute end, the refresh cookie's max age (spec 0003, AC-16). */
  sessionAbsoluteExpiresAt: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    roles: { role: string; system: string }[];
  };
};

/**
 * How a grant ended (AC-16a): `ended` for `invalid_grant` (the cookie is cleared), `no_access`
 * for 403 `NO_SYSTEM_ACCESS`, `unavailable` for anything else (the cookie is kept).
 */
export type GrantResult =
  | { kind: 'ok'; grant: UserGrant }
  | { kind: 'ended' }
  | { kind: 'no_access' }
  | { kind: 'unavailable'; reason: string };

/** The VRMS backend's calls to welinc-auth with its client assertion (spec 0003). */
@Injectable()
export class AuthClient {
  private readonly logger = new Logger('AuthClient');

  constructor(
    @Inject(SESSION_CONFIG) private readonly config: SessionConfig,
    @Inject(ASSERTION_SIGNER) private readonly signer: AssertionSigner,
  ) {}

  /** The code exchange after the login callback (AC-15). */
  exchangeCode(
    code: string,
    verifier: string,
    userAddress: string | null,
  ): Promise<GrantResult> {
    return this.grant(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
        code_verifier: verifier,
      },
      userAddress,
    );
  }

  /** Swaps the refresh cookie for a new pair (AC-7 to AC-10). */
  refresh(
    refreshToken: string,
    userAddress: string | null,
  ): Promise<GrantResult> {
    return this.grant(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      userAddress,
    );
  }

  private async grant(
    fields: Record<string, string>,
    userAddress: string | null,
  ): Promise<GrantResult> {
    let res: Response;
    try {
      const body = new URLSearchParams({
        ...fields,
        client_assertion_type:
          'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await this.signer.sign(),
      });
      res = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(userAddress ? { 'X-WeLinc-User-Address': userAddress } : {}),
        },
        body,
        signal: AbortSignal.timeout(AUTH_CALL_TIMEOUT_MS),
      });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      return this.unavailable(
        `no answer (${typeof name === 'string' ? name : 'error'})`,
      );
    }

    const body = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (res.status === 200) {
      const grant = toGrant(body);
      return grant
        ? { kind: 'ok', grant }
        : this.unavailable('unreadable answer');
    }
    if (res.status === 400 && body?.['error'] === 'invalid_grant') {
      return { kind: 'ended' };
    }
    if (res.status === 403 && body?.['code'] === 'NO_SYSTEM_ACCESS') {
      return { kind: 'no_access' };
    }
    const error = typeof body?.['error'] === 'string' ? body['error'] : '-';
    return this.unavailable(`status ${res.status} error=${error}`);
  }

  private unavailable(reason: string): GrantResult {
    this.logger.warn(`welinc-auth token call failed: ${reason}`);
    return { kind: 'unavailable', reason };
  }
}

function toGrant(body: Record<string, unknown> | null): UserGrant | null {
  const user = body?.['user'] as Record<string, unknown> | undefined;
  if (
    !body ||
    typeof body['access_token'] !== 'string' ||
    typeof body['refresh_token'] !== 'string' ||
    typeof body['expires_in'] !== 'number' ||
    typeof body['sid'] !== 'string' ||
    typeof body['session_expires_at'] !== 'string' ||
    typeof user?.['id'] !== 'string' ||
    typeof user['name'] !== 'string' ||
    typeof user['email'] !== 'string' ||
    !Array.isArray(user['roles'])
  ) {
    return null;
  }
  const absolute = body['session_absolute_expires_at'];
  return {
    accessToken: body['access_token'],
    refreshToken: body['refresh_token'],
    expiresIn: body['expires_in'],
    sid: body['sid'],
    sessionExpiresAt: body['session_expires_at'],
    sessionAbsoluteExpiresAt: typeof absolute === 'string' ? absolute : null,
    user: {
      id: user['id'],
      name: user['name'],
      email: user['email'],
      roles: user['roles'] as { role: string; system: string }[],
    },
  };
}
