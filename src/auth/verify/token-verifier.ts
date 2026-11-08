import { jwtVerify, type JWTPayload } from 'jose';
import { KeysUnavailableError, ResilientKeySet } from './key-set';

/** Clock leeway for every time check, in seconds (spec 0002). */
export const CLOCK_LEEWAY_SECONDS = 5;

/** A checked user access token (spec 0001 section 5). */
export type UserToken = {
  tokenUse: 'user';
  sub: string;
  email: string;
  aud: string;
  clientId: string;
  roles: { role: string; system: string }[];
  exp: number;
  jti: string;
  /** The session id (spec 0003, AC-1). Null on a token from before sessions, which is refused. */
  sid: string | null;
};

/** A checked service access token. */
export type ServiceToken = {
  tokenUse: 'service';
  sub: string;
  clientId: string;
  aud: string;
  scopes: string[];
  exp: number;
  jti: string;
};

export type AccessToken = UserToken | ServiceToken;

/** Why a token was refused. `unavailable` answers 503, the others 401. */
export type TokenFailure =
  | 'invalid'
  | 'expired'
  | 'wrong_audience'
  | 'unavailable';

export class TokenCheckError extends Error {
  constructor(
    readonly failure: TokenFailure,
    readonly detail: string,
  ) {
    super(`token refused: ${failure} (${detail})`);
    this.name = 'TokenCheckError';
  }
}

export type VerifierOptions = {
  /** `AUTH_ISSUER`, compared character for character. */
  issuer: string;
  /** This service's audience, e.g. `VRMS`. */
  audience: string;
  keys: ResilientKeySet;
};

/**
 * Checks an access token from welinc-auth (spec 0002, AC-10): only ES256, `typ: at+jwt`, this
 * issuer, an unexpired `exp` (5 s leeway) and a single string `aud` equal to this service's.
 * A good signature with another `aud` fails as `wrong_audience`.
 */
export class TokenVerifier {
  constructor(private readonly options: VerifierOptions) {}

  async verify(token: string): Promise<AccessToken> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.options.keys.getKey, {
        algorithms: ['ES256'],
        typ: 'at+jwt',
        issuer: this.options.issuer,
        clockTolerance: CLOCK_LEEWAY_SECONDS,
        requiredClaims: ['exp', 'sub', 'aud', 'jti'],
      }));
    } catch (error) {
      if (error instanceof KeysUnavailableError) {
        throw new TokenCheckError('unavailable', 'keys');
      }
      const code = (error as { code?: string }).code ?? 'unknown';
      // Spec 0003, AC-27: an expired token is told apart, so the web app refreshes and retries
      throw new TokenCheckError(
        code === 'ERR_JWT_EXPIRED' ? 'expired' : 'invalid',
        code,
      );
    }

    const { aud, sub, exp, jti } = payload;
    if (typeof aud !== 'string') {
      throw new TokenCheckError('invalid', 'aud_not_single');
    }
    if (aud !== this.options.audience) {
      throw new TokenCheckError('wrong_audience', aud);
    }
    const clientId = payload['client_id'];
    if (
      typeof sub !== 'string' ||
      typeof exp !== 'number' ||
      typeof jti !== 'string' ||
      typeof clientId !== 'string'
    ) {
      throw new TokenCheckError('invalid', 'bad_claims');
    }

    if (payload['token_use'] === 'user') {
      const email = payload['email'];
      const roles = payload['roles'];
      const sid = payload['sid'];
      if (typeof email !== 'string' || !Array.isArray(roles)) {
        throw new TokenCheckError('invalid', 'bad_claims');
      }
      return {
        tokenUse: 'user',
        sub,
        email,
        aud,
        clientId,
        roles: roles as UserToken['roles'],
        exp,
        jti,
        sid: typeof sid === 'string' && sid !== '' ? sid : null,
      };
    }

    if (payload['token_use'] === 'service') {
      const scope = payload['scope'];
      if (typeof scope !== 'string') {
        throw new TokenCheckError('invalid', 'bad_claims');
      }
      return {
        tokenUse: 'service',
        sub,
        clientId,
        aud,
        scopes: scope.split(' ').filter(Boolean),
        exp,
        jti,
      };
    }

    throw new TokenCheckError('invalid', 'no_token_use');
  }
}
