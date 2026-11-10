import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VERIFY_CONFIG, type VerifyConfig } from '../auth/verify';
import type { Env } from '../config/env';

/**
 * What the VRMS session routes need (spec 0003, Configuration required). Each address is kept
 * without a trailing slash.
 */
export type SessionConfig = {
  /** `WEB_APP_URL`: where users land, and the one `Origin` the cookie routes accept. */
  webAppUrl: string;
  webAppOrigin: string;
  /** `PORTAL_URL`: where callback failures and logins go. */
  portalUrl: string;
  /** `AUTH_PUBLIC_URL`: welinc-auth as the browser sees it, for `/auth/authorize`. */
  authPublicUrl: string;
  /** `API_PUBLIC_URL` + `/vrms/session/callback`, character for character the registry row. */
  redirectUri: string;
  /** `SESSION_COOKIE_SECURE`: `Secure` plus the `__Secure-` prefix when hosted. */
  cookieSecure: boolean;
  clientId: string;
  tokenUrl: string;
  /** `/auth/logout` and `/auth/session/activity` on welinc-auth's internal address (AC-24, AC-42). */
  logoutUrl: string;
  activityUrl: string;
};

export const SESSION_CONFIG = Symbol('SESSION_CONFIG');

type AddressName =
  | 'WEB_APP_URL'
  | 'API_PUBLIC_URL'
  | 'PORTAL_URL'
  | 'AUTH_PUBLIC_URL';

/** The boot check (spec 0010) already made each one a required URL; only the slash goes here. */
const address = (config: ConfigService<Env, true>, name: AddressName) =>
  config.get(name, { infer: true }).replace(/\/+$/, '');

export function readSessionConfig(
  config: ConfigService<Env, true>,
  verify: VerifyConfig,
): SessionConfig {
  const webAppUrl = address(config, 'WEB_APP_URL');
  const apiPublicUrl = address(config, 'API_PUBLIC_URL');
  return {
    webAppUrl,
    webAppOrigin: new URL(webAppUrl).origin,
    portalUrl: address(config, 'PORTAL_URL'),
    authPublicUrl: address(config, 'AUTH_PUBLIC_URL'),
    redirectUri: `${apiPublicUrl}/vrms/session/callback`,
    cookieSecure: config.get('SESSION_COOKIE_SECURE', { infer: true }),
    clientId: verify.clientId,
    tokenUrl: `${verify.internalUrl}/auth/token`,
    logoutUrl: `${verify.internalUrl}/auth/logout`,
    activityUrl: `${verify.internalUrl}/auth/session/activity`,
  };
}

export const sessionConfigProvider: Provider = {
  provide: SESSION_CONFIG,
  inject: [ConfigService, VERIFY_CONFIG],
  useFactory: readSessionConfig,
};
