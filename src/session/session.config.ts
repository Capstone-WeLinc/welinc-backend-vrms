import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VERIFY_CONFIG, type VerifyConfig } from '../auth/verify';

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

const trim = (value: string) => value.trim().replace(/\/+$/, '');

function address(config: ConfigService, name: string, fallback: string) {
  const raw = config.get<string>(name)?.trim();
  if (!raw && config.get<string>('NODE_ENV') === 'production') {
    throw new Error(`${name} is required in production (spec 0003)`);
  }
  const value = trim(raw || fallback);
  new URL(value); // refuses a malformed address at startup
  return value;
}

export function readSessionConfig(
  config: ConfigService,
  verify: VerifyConfig,
): SessionConfig {
  const webAppUrl = address(config, 'WEB_APP_URL', 'http://localhost:8001');
  const apiPublicUrl = address(
    config,
    'API_PUBLIC_URL',
    'http://localhost:3000',
  );
  const secure = config
    .get<string>('SESSION_COOKIE_SECURE')
    ?.trim()
    .toLowerCase();
  return {
    webAppUrl,
    webAppOrigin: new URL(webAppUrl).origin,
    portalUrl: address(config, 'PORTAL_URL', 'http://localhost:8000'),
    authPublicUrl: address(
      config,
      'AUTH_PUBLIC_URL',
      'http://localhost:3000/auth',
    ),
    redirectUri: `${apiPublicUrl}/vrms/session/callback`,
    cookieSecure: secure === 'true' || secure === '1',
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
