import { errors } from 'jose';
import { KeysUnavailableError, ResilientKeySet } from './key-set';
import {
  fakeJwksFetch,
  testSigner,
  type TestSigner,
} from './testing/test-auth';

const MINUTE = 60_000;

// covers: spec 0002 AC-11 (5 minute cache, refetch for an unknown kid at most once a minute),
// AC-12 (last good set for up to an hour, then 503, never 401)
describe('ResilientKeySet', () => {
  let a: TestSigner;
  let b: TestSigner;
  let clock: number;
  let served: TestSigner[];

  beforeAll(async () => {
    a = await testSigner('auth-a');
    b = await testSigner('auth-b');
  });

  beforeEach(() => {
    clock = 1_000_000;
    served = [a];
  });

  function build() {
    const jwks = fakeJwksFetch(() => ({
      keys: served.flatMap((s) => s.jwks.keys),
    }));
    const set = new ResilientKeySet({
      url: 'http://auth/jwks',
      fetch: jwks.fn,
      now: () => clock,
    });
    const key = (kid: string) => set.getKey({ alg: 'ES256', kid }, {} as never);
    return { jwks, key };
  }

  it('fetches once and serves from the cache for 5 minutes', async () => {
    const { jwks, key } = build();
    await key('auth-a');
    clock += 4 * MINUTE;
    await key('auth-a');
    expect(jwks.state.calls).toBe(1);
    clock += 2 * MINUTE;
    await key('auth-a');
    expect(jwks.state.calls).toBe(2);
  });

  it('shares one fetch between callers who arrive together', async () => {
    const { jwks, key } = build();
    await Promise.all([key('auth-a'), key('auth-a'), key('auth-a')]);
    expect(jwks.state.calls).toBe(1);
  });

  it('fetches again for a new kid, so a rotation needs no restart', async () => {
    const { jwks, key } = build();
    await key('auth-a');
    served = [a, b];
    clock += MINUTE;
    await expect(key('auth-b')).resolves.toBeDefined();
    expect(jwks.state.calls).toBe(2);
  });

  it('answers no matching key (401) for a kid still unknown after a fetch, and fetches at most once a minute', async () => {
    const { jwks, key } = build();
    await key('auth-a');
    clock += MINUTE;
    await expect(key('auth-zzz')).rejects.toBeInstanceOf(
      errors.JWKSNoMatchingKey,
    );
    await expect(key('auth-zzz')).rejects.toBeInstanceOf(
      errors.JWKSNoMatchingKey,
    );
    expect(jwks.state.calls).toBe(2);
    clock += MINUTE;
    await expect(key('auth-zzz')).rejects.toBeInstanceOf(
      errors.JWKSNoMatchingKey,
    );
    expect(jwks.state.calls).toBe(3);
  });

  it('keeps verifying with the last good set for up to an hour while welinc-auth is down', async () => {
    const { jwks, key } = build();
    await key('auth-a');
    jwks.state.down = true;
    clock += 30 * MINUTE;
    await expect(key('auth-a')).resolves.toBeDefined();
    clock += 30 * MINUTE;
    await expect(key('auth-a')).resolves.toBeDefined();
    clock += MINUTE;
    await expect(key('auth-a')).rejects.toBeInstanceOf(KeysUnavailableError);
  });

  it('answers unavailable (503) for an unknown kid when the set could not be refreshed', async () => {
    const { jwks, key } = build();
    await key('auth-a');
    jwks.state.down = true;
    clock += MINUTE;
    await expect(key('auth-b')).rejects.toBeInstanceOf(KeysUnavailableError);
  });

  it('answers unavailable with no set at all, and does not refetch on every request', async () => {
    const { jwks, key } = build();
    jwks.state.down = true;
    await expect(key('auth-a')).rejects.toBeInstanceOf(KeysUnavailableError);
    await expect(key('auth-a')).rejects.toBeInstanceOf(KeysUnavailableError);
    expect(jwks.state.calls).toBe(1);
    jwks.state.down = false;
    clock += MINUTE;
    await expect(key('auth-a')).resolves.toBeDefined();
  });

  it('treats a non 200 answer as a failed fetch', async () => {
    const { jwks, key } = build();
    jwks.state.status = 500;
    await expect(key('auth-a')).rejects.toBeInstanceOf(KeysUnavailableError);
  });
});
