import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';

/**
 * Test only: plays welinc-auth with a key pair made fresh each run (spec 0002, task 1a). Never
 * written to any env file.
 */
export const TEST_ISSUER = 'http://localhost:3000/auth';

export type TestSigner = {
  kid: string;
  privateKey: CryptoKey;
  jwks: JSONWebKeySet;
};

export async function testSigner(kid = 'auth-test-1'): Promise<TestSigner> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: 'ES256',
    use: 'sig',
  };
  return { kid, privateKey, jwks: { keys: [jwk] } };
}

/** Signs an access token the way welinc-auth does; `claims` and `header` override the defaults. */
export function signAccess(
  signer: TestSigner,
  claims: JWTPayload = {},
  header: Record<string, unknown> = {},
  expiresIn: string | number = '5m',
): Promise<string> {
  return new SignJWT({
    iss: TEST_ISSUER,
    sub: 'user-1',
    aud: 'VRMS',
    client_id: 'portal',
    token_use: 'user',
    email: 'mech.juan@welinc.com',
    roles: [{ role: 'MECHANIC', system: 'VRMS' }],
    jti: 'jti-1',
    ...claims,
  })
    .setProtectedHeader({
      alg: 'ES256',
      kid: signer.kid,
      typ: 'at+jwt',
      ...header,
    })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(signer.privateKey);
}

/** A `fetch` that serves `body()` as the JWKS, or fails while `down` is true. Counts calls. */
export function fakeJwksFetch(body: () => JSONWebKeySet) {
  const state = { calls: 0, down: false, status: 200 };
  const fn = (() => {
    state.calls++;
    if (state.down) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(
      new Response(JSON.stringify(body()), {
        status: state.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { fn, state };
}
