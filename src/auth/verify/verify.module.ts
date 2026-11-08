import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssertionSigner } from './assertion-signer';
import { TOKEN_VERIFIER } from './guards';
import { ServiceTokenClient } from './service-token-client';
import { ResilientKeySet } from './key-set';
import { TokenVerifier } from './token-verifier';

/** The settings the token check needs. Each one missing stops the service at startup (AC-22). */
export type VerifyConfig = {
  issuer: string;
  jwksUrl: string;
  /** welinc-auth's address on the internal network, for `/auth/token` and other calls. */
  internalUrl: string;
  /** This service's client id at welinc-auth (`AUTH_CLIENT_ID`). */
  clientId: string;
};

export const VERIFY_CONFIG = Symbol('VERIFY_CONFIG');

/** Signs this service's client assertions with `AUTH_CLIENT_PRIVATE_KEY` (spec 0002, 0003). */
export const ASSERTION_SIGNER = Symbol('ASSERTION_SIGNER');

/** This service's token for welinc-auth's directory: `audience=AUTH`, `scope=directory.read`. */
export const DIRECTORY_TOKENS = Symbol('DIRECTORY_TOKENS');

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
    clientId: required(config, 'AUTH_CLIENT_ID'),
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
    {
      provide: ASSERTION_SIGNER,
      inject: [VERIFY_CONFIG, ConfigService],
      // Async, so a missing or bad AUTH_CLIENT_PRIVATE_KEY stops startup (AC-22)
      useFactory: (verify: VerifyConfig, config: ConfigService) =>
        AssertionSigner.create({
          clientId: verify.clientId,
          privateKey: config.get<string>('AUTH_CLIENT_PRIVATE_KEY'),
          issuer: verify.issuer,
        }),
    },
    {
      provide: DIRECTORY_TOKENS,
      inject: [VERIFY_CONFIG, ASSERTION_SIGNER],
      useFactory: (verify: VerifyConfig, signer: AssertionSigner) => {
        const logger = new Logger('ServiceToken');
        return new ServiceTokenClient({
          tokenUrl: `${verify.internalUrl}/auth/token`,
          signer,
          audience: 'AUTH',
          scope: 'directory.read',
          onError: (reason) =>
            logger.warn(`could not get a service token: ${reason}`),
        });
      },
    },
  ],
  exports: [VERIFY_CONFIG, TOKEN_VERIFIER, ASSERTION_SIGNER, DIRECTORY_TOKENS],
})
export class AuthVerifyModule {}
