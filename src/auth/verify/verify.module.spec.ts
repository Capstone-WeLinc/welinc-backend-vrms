import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { readVerifyConfig } from './verify.module';

const config = (values: Record<string, string>) =>
  ({ get: (name: string) => values[name] }) as unknown as ConfigService<
    Env,
    true
  >;

const ALL = {
  AUTH_ISSUER: 'http://localhost:3000/auth',
  AUTH_JWKS_URL: 'http://auth-service:3001/auth/.well-known/jwks.json',
  AUTH_INTERNAL_URL: 'http://auth-service:3001/',
  AUTH_CLIENT_ID: 'vrms',
};

// covers: spec 0002 AC-22. A missing setting is refused at boot by validateEnv (spec 0010, env.spec.ts).
describe('readVerifyConfig', () => {
  it('reads the settings and trims a trailing slash from the internal address', () => {
    expect(readVerifyConfig(config(ALL))).toEqual({
      issuer: ALL.AUTH_ISSUER,
      jwksUrl: ALL.AUTH_JWKS_URL,
      internalUrl: 'http://auth-service:3001',
      clientId: 'vrms',
    });
  });
});
