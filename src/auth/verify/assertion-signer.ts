import { randomUUID } from 'crypto';
import { importJWK, SignJWT, type CryptoKey, type JWK } from 'jose';

/** A client assertion lives 60 s, the most welinc-auth accepts (spec 0001 section 5). */
export const ASSERTION_SECONDS = 60;

/**
 * Checks `AUTH_CLIENT_PRIVATE_KEY`: one private EC P-256 JWK with a `kid` and `alg: ES256`
 * (spec 0002, AC-22). The message names the problem, never the key.
 */
export function parseClientKey(raw: string | undefined): JWK & { kid: string } {
  if (!raw || raw.trim() === '') {
    throw new Error(
      'AUTH_CLIENT_PRIVATE_KEY is missing. Run `npm run keys:dev` in welinc-auth.',
    );
  }
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('AUTH_CLIENT_PRIVATE_KEY is not valid JSON');
  }
  if (
    typeof jwk !== 'object' ||
    jwk === null ||
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.d !== 'string' ||
    typeof jwk.kid !== 'string' ||
    jwk.kid === '' ||
    jwk.alg !== 'ES256'
  ) {
    throw new Error(
      'AUTH_CLIENT_PRIVATE_KEY must be a private EC P-256 JWK with a kid and alg ES256',
    );
  }
  return jwk as JWK & { kid: string };
}

/** Signs the `private_key_jwt` assertion this service proves itself with: a fresh one per request. */
export class AssertionSigner {
  private constructor(
    readonly clientId: string,
    private readonly kid: string,
    private readonly key: CryptoKey,
    /** `<AUTH_ISSUER>/token`. */
    private readonly audience: string,
  ) {}

  static async create(options: {
    clientId: string;
    privateKey: string | undefined;
    issuer: string;
  }): Promise<AssertionSigner> {
    const jwk = parseClientKey(options.privateKey);
    let key: CryptoKey;
    try {
      key = (await importJWK(jwk, 'ES256')) as CryptoKey;
    } catch {
      throw new Error(
        'AUTH_CLIENT_PRIVATE_KEY could not be imported: the key is damaged',
      );
    }
    return new AssertionSigner(
      options.clientId,
      jwk.kid,
      key,
      `${options.issuer}/token`,
    );
  }

  sign(nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: this.kid })
      .setIssuer(this.clientId)
      .setSubject(this.clientId)
      .setAudience(this.audience)
      .setJti(randomUUID())
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + ASSERTION_SECONDS)
      .sign(this.key);
  }
}
