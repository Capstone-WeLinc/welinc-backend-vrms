import type { CookieOptions, Request, Response } from 'express';
import type { SessionConfig } from './session.config';

/** Both VRMS cookies live on this path only (spec 0001 section 7). */
export const COOKIE_PATH = '/vrms/session';
/** A login attempt has 10 minutes to come back (spec 0001 section 7). */
export const LOGIN_STATE_MS = 10 * 60_000;

const prefix = (config: SessionConfig) =>
  config.cookieSecure ? '__Secure-' : '';

function options(config: SessionConfig): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: COOKIE_PATH,
  };
}

/** `vrms_rt`, or `__Secure-vrms_rt` when hosted. */
export const refreshCookieName = (config: SessionConfig) =>
  `${prefix(config)}vrms_rt`;

/**
 * The login state cookie, named per attempt by the first 8 characters of `state` (AC-16), so
 * several tabs logging in at once don't overwrite each other.
 */
export const loginCookieName = (config: SessionConfig, state: string) =>
  `${prefix(config)}vrms_login_${state.slice(0, 8)}`;

function read(request: Request, name: string): string | null {
  const value = (request.cookies as Record<string, unknown> | undefined)?.[
    name
  ];
  return typeof value === 'string' && value !== '' ? value : null;
}

export const readRefreshCookie = (request: Request, config: SessionConfig) =>
  read(request, refreshCookieName(config));

/** The refresh cookie lives to the session's absolute end, never its idle cutoff (AC-16). */
export function setRefreshCookie(
  response: Response,
  config: SessionConfig,
  token: string,
  absoluteEnd: Date,
): void {
  response.cookie(refreshCookieName(config), token, {
    ...options(config),
    maxAge: Math.max(0, absoluteEnd.getTime() - Date.now()),
  });
}

export function clearRefreshCookie(response: Response, config: SessionConfig) {
  response.clearCookie(refreshCookieName(config), options(config));
}

/** What a login attempt keeps until its callback: the state, the PKCE verifier, the return path. */
export type LoginState = { state: string; verifier: string; returnTo: string };

export function setLoginCookie(
  response: Response,
  config: SessionConfig,
  login: LoginState,
): void {
  const value = Buffer.from(JSON.stringify(login), 'utf8').toString(
    'base64url',
  );
  response.cookie(loginCookieName(config, login.state), value, {
    ...options(config),
    maxAge: LOGIN_STATE_MS,
  });
}

export function readLoginCookie(
  request: Request,
  config: SessionConfig,
  state: string,
): LoginState | null {
  const raw = read(request, loginCookieName(config, state));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<LoginState>;
    if (
      typeof parsed.state !== 'string' ||
      typeof parsed.verifier !== 'string' ||
      typeof parsed.returnTo !== 'string'
    ) {
      return null;
    }
    return parsed as LoginState;
  } catch {
    return null;
  }
}

export function clearLoginCookie(
  response: Response,
  config: SessionConfig,
  state: string,
) {
  response.clearCookie(loginCookieName(config, state), options(config));
}
