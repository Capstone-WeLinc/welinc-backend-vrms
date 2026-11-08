import { createHmac } from 'crypto';
import { ResilientKeySet } from './key-set';
import { TokenCheckError, TokenVerifier } from './token-verifier';
import {
  fakeJwksFetch,
  signAccess,
  TEST_ISSUER,
  testSigner,
  type TestSigner,
} from './testing/test-auth';

const b64 = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TokenCheckError);
  return (error as TokenCheckError).failure;
}

// covers: spec 0002 AC-10 (what backend-vrms accepts)
describe('TokenVerifier', () => {
  let signer: TestSigner;
  let verifier: TokenVerifier;

  beforeAll(async () => {
    signer = await testSigner();
    const jwks = fakeJwksFetch(() => signer.jwks);
    verifier = new TokenVerifier({
      issuer: TEST_ISSUER,
      audience: 'VRMS',
      keys: new ResilientKeySet({ url: 'http://auth/jwks', fetch: jwks.fn }),
    });
  });

  it('accepts a VRMS user token and reads its claims', async () => {
    await expect(
      verifier.verify(await signAccess(signer)),
    ).resolves.toMatchObject({
      tokenUse: 'user',
      sub: 'user-1',
      aud: 'VRMS',
      email: 'mech.juan@welinc.com',
      roles: [{ role: 'MECHANIC', system: 'VRMS' }],
    });
  });

  it('accepts a service token for VRMS and splits its scopes', async () => {
    const token = await signAccess(signer, {
      sub: 'client:vmms',
      client_id: 'vmms',
      token_use: 'service',
      scope: 'a.read b.write',
      email: undefined,
      roles: undefined,
    });
    await expect(verifier.verify(token)).resolves.toMatchObject({
      tokenUse: 'service',
      clientId: 'vmms',
      scopes: ['a.read', 'b.write'],
    });
  });

  it('fails a good signature for another system as wrong_audience', async () => {
    expect(
      await failure(verifier.verify(await signAccess(signer, { aud: 'BMS' }))),
    ).toBe('wrong_audience');
  });

  it('fails an aud list, another issuer, the wrong typ and no token_use as invalid', async () => {
    expect(
      await failure(
        verifier.verify(await signAccess(signer, { aud: ['VRMS'] })),
      ),
    ).toBe('invalid');
    expect(
      await failure(
        verifier.verify(await signAccess(signer, { iss: 'http://evil/auth' })),
      ),
    ).toBe('invalid');
    expect(
      await failure(
        verifier.verify(await signAccess(signer, {}, { typ: 'JWT' })),
      ),
    ).toBe('invalid');
    expect(
      await failure(
        verifier.verify(await signAccess(signer, { token_use: undefined })),
      ),
    ).toBe('invalid');
  });

  it('allows 5 s of clock leeway on exp, not more', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifier.verify(await signAccess(signer, {}, {}, now - 3)),
    ).resolves.toBeDefined();
    expect(
      await failure(
        verifier.verify(await signAccess(signer, {}, {}, now - 10)),
      ),
      // spec 0003 AC-27: told apart as expired, so the caller gets TOKEN_EXPIRED
    ).toBe('expired');
  });

  it('fails an old HS256 token, alg none, and HS256 keyed with the public key', async () => {
    const body = b64({
      iss: TEST_ISSUER,
      sub: 'u',
      aud: 'VRMS',
      jti: 'j',
      client_id: 'portal',
      token_use: 'user',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const hs = (secret: string, kid?: string) => {
      const header = b64({
        alg: 'HS256',
        typ: 'at+jwt',
        ...(kid ? { kid } : {}),
      });
      return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
    };
    expect(
      await failure(verifier.verify(hs('dev_secret_key_change_in_production'))),
    ).toBe('invalid');
    expect(
      await failure(
        verifier.verify(hs(JSON.stringify(signer.jwks.keys[0]), signer.kid)),
      ),
    ).toBe('invalid');
    expect(
      await failure(
        verifier.verify(`${b64({ alg: 'none', typ: 'at+jwt' })}.${body}.`),
      ),
    ).toBe('invalid');
  });

  it('fails a token signed by a key welinc-auth never published', async () => {
    const stranger = await testSigner('auth-test-1');
    expect(await failure(verifier.verify(await signAccess(stranger)))).toBe(
      'invalid',
    );
  });
});
