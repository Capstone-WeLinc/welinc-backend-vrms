import type { ConfigService } from '@nestjs/config';
import { readVerifyConfig } from './verify.module';

const config = (values: Record<string, string>) =>
  ({ get: (name: string) => values[name] }) as unknown as ConfigService;

const ALL = {
  AUTH_ISSUER: 'http://localhost:3000/auth',
  AUTH_JWKS_URL: 'http://auth-service:3001/auth/.well-known/jwks.json',
  AUTH_INTERNAL_URL: 'http://auth-service:3001/',
};

// covers: spec 0002 AC-22 (refuse to start without the token check settings)
describe('readVerifyConfig', () => {
  it('reads the settings and trims a trailing slash from the internal address', () => {
    expect(readVerifyConfig(config(ALL))).toEqual({
      issuer: ALL.AUTH_ISSUER,
      jwksUrl: ALL.AUTH_JWKS_URL,
      internalUrl: 'http://auth-service:3001',
    });
  });

  it.each(Object.keys(ALL))('refuses to start without %s', (name) => {
    expect(() => readVerifyConfig(config({ ...ALL, [name]: '' }))).toThrow(
      `${name} is missing`,
    );
  });
});
