import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TOKEN_VERIFIER } from './guards';
import { ResilientKeySet } from './key-set';
import { TokenVerifier } from './token-verifier';

/** The settings the token check needs. Each one missing stops the service at startup (AC-22). */
export type VerifyConfig = {
  issuer: string;
  jwksUrl: string;
  /** welinc-auth's address on the internal network, for `/auth/token` and other calls. */
  internalUrl: string;
};

export const VERIFY_CONFIG = Symbol('VERIFY_CONFIG');

/** The audience this service accepts. Change it when copying the folder (`VMMS`, `BMS`). */
export const SERVICE_AUDIENCE = 'VRMS';

function required(config: ConfigService, name: string): string {
  const value = config.get<string>(name)?.trim();
  if (!value)
    throw new Error(`${name} is missing. See src/auth/verify/README.md.`);
  return value;
}

export function readVerifyConfig(config: ConfigService): VerifyConfig {
  return {
    issuer: required(config, 'AUTH_ISSUER'),
    jwksUrl: required(config, 'AUTH_JWKS_URL'),
    internalUrl: required(config, 'AUTH_INTERNAL_URL').replace(/\/+$/, ''),
  };
}

/**
 * The token check, ready to inject anywhere: `TOKEN_VERIFIER` and `VERIFY_CONFIG`. Needs
 * `ConfigModule` loaded globally.
 */
@Global()
@Module({
  providers: [
    {
      provide: VERIFY_CONFIG,
      inject: [ConfigService],
      useFactory: readVerifyConfig,
    },
    {
      provide: TOKEN_VERIFIER,
      inject: [VERIFY_CONFIG],
      useFactory: (config: VerifyConfig) => {
        const logger = new Logger('AuthKeys');
        const keys = new ResilientKeySet({
          url: config.jwksUrl,
          onFetchError: (reason) =>
            logger.warn(`could not fetch welinc-auth's keys: ${reason}`),
        });
        return new TokenVerifier({
          issuer: config.issuer,
          audience: SERVICE_AUDIENCE,
          keys,
        });
      },
    },
  ],
  exports: [VERIFY_CONFIG, TOKEN_VERIFIER],
})
export class AuthVerifyModule {}
