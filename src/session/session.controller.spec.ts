import { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AccountCheck } from '../auth/account-check';
import type { TokenVerifier } from '../auth/verify';
import type { AuthClient, GrantResult } from './auth-client';
import { loginCookieName } from './cookies';
import { SessionController } from './session.controller';
import type { SessionConfig } from './session.config';

// covers: suite spec 0014 AC-3 (the APP_NOT_ALLOWED handling the VMMS and BMS copies inherit)

const CONFIG = {
  webAppUrl: 'http://localhost:8001',
  webAppOrigin: 'http://localhost:8001',
  portalUrl: 'http://localhost:8000',
  authPublicUrl: 'http://localhost:3000',
  redirectUri: 'http://localhost:3000/vrms/session/callback',
  cookieSecure: false,
  clientId: 'vrms',
  tokenUrl: 'http://auth/auth/token',
  logoutUrl: 'http://auth/auth/logout',
  activityUrl: 'http://auth/auth/session/activity',
} as SessionConfig;

const STATE = 'a'.repeat(43);

function loginRequest(extra: Record<string, string> = {}): Request {
  const login = Buffer.from(
    JSON.stringify({ state: STATE, verifier: 'v'.repeat(43), returnTo: '/' }),
    'utf8',
  ).toString('base64url');
  return {
    cookies: { [loginCookieName(CONFIG, STATE)]: login, ...extra },
    ip: '127.0.0.1',
  } as unknown as Request;
}

function response() {
  const res = {
    setHeader: jest.fn(),
    redirect: jest.fn(),
    clearCookie: jest.fn(),
    cookie: jest.fn(),
  };
  return res;
}

function build(result: GrantResult) {
  const auth = {
    exchangeCode: jest.fn().mockResolvedValue(result),
    refresh: jest.fn().mockResolvedValue(result),
  };
  const controller = new SessionController(
    CONFIG,
    {} as TokenVerifier,
    auth as unknown as AuthClient,
    {} as AccountCheck,
  );
  return { controller, auth };
}

const location = (res: ReturnType<typeof response>) =>
  new URL(String((res.redirect.mock.calls[0] as unknown[])[1]));

describe('SessionController callback, spec 0014 AC-3', () => {
  it('sends error_description=APP_NOT_ALLOWED to the portal with the system code', async () => {
    const { controller, auth } = build({ kind: 'ended' });
    const res = response();
    await controller.callback(
      undefined,
      STATE,
      'access_denied',
      'APP_NOT_ALLOWED',
      loginRequest(),
      res as unknown as Response,
    );
    const url = location(res);
    expect(url.origin + url.pathname).toBe('http://localhost:8000/');
    expect(url.searchParams.get('error')).toBe('APP_NOT_ALLOWED');
    expect(url.searchParams.get('system')).toBe('VRMS');
    expect(auth.exchangeCode).not.toHaveBeenCalled();
  });

  it('keeps NO_SYSTEM_ACCESS for a plain access_denied', async () => {
    const { controller } = build({ kind: 'ended' });
    const res = response();
    await controller.callback(
      undefined,
      STATE,
      'access_denied',
      undefined,
      loginRequest(),
      res as unknown as Response,
    );
    expect(location(res).searchParams.get('error')).toBe('NO_SYSTEM_ACCESS');
  });

  it('sends an exchange answered APP_NOT_ALLOWED to the same portal page', async () => {
    const { controller } = build({ kind: 'not_allowed' });
    const res = response();
    await controller.callback(
      'code-1',
      STATE,
      undefined,
      undefined,
      loginRequest(),
      res as unknown as Response,
    );
    const url = location(res);
    expect(url.searchParams.get('error')).toBe('APP_NOT_ALLOWED');
    expect(url.searchParams.get('system')).toBe('VRMS');
  });
});

describe('SessionController refresh, spec 0014 AC-3', () => {
  it('clears the cookie and answers 403 APP_NOT_ALLOWED', async () => {
    const { controller } = build({ kind: 'not_allowed' });
    const res = response();
    const error = await controller
      .refresh(
        { cookies: { vrms_rt: 'r'.repeat(43) } } as unknown as Request,
        res as unknown as Response,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    expect(http.getStatus()).toBe(403);
    expect(http.getResponse()).toMatchObject({ code: 'APP_NOT_ALLOWED' });
    expect(res.clearCookie).toHaveBeenCalledWith('vrms_rt', expect.anything());
  });
});
