import {
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from 'jose';
import {
  ASSERTION_SECONDS,
  AssertionSigner,
  parseClientKey,
} from './assertion-signer';

async function privateJwk(overrides: Record<string, unknown> = {}) {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  return { ...jwk, kid: 'client-20261108-abc123', alg: 'ES256', ...overrides };
}

// covers: spec 0002 AC-22 (client key checks name the problem, never the key)
describe('parseClientKey', () => {
  it('accepts a private EC P-256 key with kid and ES256', async () => {
    const jwk = await privateJwk();

    expect(parseClientKey(JSON.stringify(jwk)).kid).toBe(
      'client-20261108-abc123',
    );
  });

  it.each([undefined, '', '   '])('says the key is missing for %p', (raw) => {
    expect(() => parseClientKey(raw)).toThrow(/is missing/);
  });

  it('says the key is not JSON without echoing it', () => {
    expect(() => parseClientKey('{secret-ish')).toThrow(/not valid JSON/);
    try {
      parseClientKey('{secret-ish');
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-ish');
    }
  });

  it.each([
    ['a public key (no d)', { d: undefined }],
    ['no kid', { kid: undefined }],
    ['an empty kid', { kid: '' }],
    ['the wrong alg', { alg: 'RS256' }],
    ['the wrong curve', { crv: 'P-384' }],
    ['the wrong key type', { kty: 'RSA' }],
  ])('rejects %s', async (_name, change) => {
    const jwk = await privateJwk(change);

    expect(() => parseClientKey(JSON.stringify(jwk))).toThrow(
      /must be a private EC P-256 JWK/,
    );
  });

  it('rejects JSON that is not an object', () => {
    expect(() => parseClientKey('null')).toThrow(
      /must be a private EC P-256 JWK/,
    );
  });
});

// covers: spec 0001 section 5 (private_key_jwt: 60 s, aud <issuer>/token, fresh jti)
describe('AssertionSigner', () => {
  const issuer = 'http://localhost:3000/auth';

  async function build() {
    const { privateKey, publicKey } = await generateKeyPair('ES256', {
      extractable: true,
    });
    const jwk = { ...(await exportJWK(privateKey)), kid: 'k1', alg: 'ES256' };
    const signer = await AssertionSigner.create({
      clientId: 'vrms-backend',
      privateKey: JSON.stringify(jwk),
      issuer,
    });
    return { signer, publicKey };
  }

  it('signs an assertion welinc-auth can verify with the public key', async () => {
    const { signer, publicKey } = await build();
    const jwt = await signer.sign(1_800_000_000);

    const { payload, protectedHeader } = await jwtVerify(jwt, publicKey, {
      audience: `${issuer}/token`,
      issuer: 'vrms-backend',
      currentDate: new Date(1_800_000_010 * 1000),
    });
    expect(payload.sub).toBe('vrms-backend');
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'k1' });
  });

  it('expires after exactly 60 seconds', async () => {
    const { signer } = await build();
    const claims = decodeJwt(await signer.sign(1_800_000_000));

    expect(claims.exp! - claims.iat!).toBe(ASSERTION_SECONDS);
    expect(ASSERTION_SECONDS).toBe(60);
  });

  it('uses a new jti for every assertion so none can be replayed', async () => {
    const { signer } = await build();
    const [a, b] = await Promise.all([signer.sign(), signer.sign()]);

    expect(decodeJwt(a).jti).not.toBe(decodeJwt(b).jti);
  });

  it('refuses a verify with another key', async () => {
    const { signer } = await build();
    const other = await generateKeyPair('ES256');

    await expect(
      jwtVerify(await signer.sign(), other.publicKey),
    ).rejects.toThrow();
  });

  it('exposes the client id and puts the kid in the header', async () => {
    const { signer } = await build();

    expect(signer.clientId).toBe('vrms-backend');
    expect(decodeProtectedHeader(await signer.sign()).kid).toBe('k1');
  });

  it('fails to create from a damaged key without leaking it', async () => {
    const jwk = await privateJwk({ x: 'AAAA', y: 'AAAA' });

    await expect(
      AssertionSigner.create({
        clientId: 'c',
        privateKey: JSON.stringify(jwk),
        issuer,
      }),
    ).rejects.toThrow(/key is damaged/);
  });
});
