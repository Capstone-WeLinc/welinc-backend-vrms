import type { Request, Response } from 'express';
import {
  COOKIE_PATH,
  LOGIN_STATE_MS,
  clearLoginCookie,
  clearRefreshCookie,
  loginCookieName,
  readLoginCookie,
  readRefreshCookie,
  refreshCookieName,
  setLoginCookie,
  setRefreshCookie,
} from './cookies';
import type { SessionConfig } from './session.config';

const local = { cookieSecure: false } as SessionConfig;
const hosted = { cookieSecure: true } as SessionConfig;

const res = () =>
  ({ cookie: jest.fn(), clearCookie: jest.fn() }) as unknown as Response & {
    cookie: jest.Mock;
    clearCookie: jest.Mock;
  };
type CookieCall = [string, string, { maxAge: number }];
const call = (r: { cookie: jest.Mock }) => r.cookie.mock.calls[0] as CookieCall;
const req = (cookies?: Record<string, unknown>) =>
  ({ cookies }) as unknown as Request;

describe('VRMS session cookies (AC-16)', () => {
  it('names the cookies per environment', () => {
    expect(refreshCookieName(local)).toBe('vrms_rt');
    expect(refreshCookieName(hosted)).toBe('__Secure-vrms_rt');
    expect(loginCookieName(local, 'abcdefghijkl')).toBe('vrms_login_abcdefgh');
    expect(loginCookieName(hosted, 'abcdefghijkl')).toBe(
      '__Secure-vrms_login_abcdefgh',
    );
  });

  it('gives two login attempts with different states different cookie names', () => {
    expect(loginCookieName(local, 'aaaaaaaa1')).not.toBe(
      loginCookieName(local, 'bbbbbbbb1'),
    );
  });

  it('lives the refresh cookie to the absolute end, not the idle cutoff', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-08T00:00:00Z'));
    const r = res();
    setRefreshCookie(r, local, 'tok', new Date('2026-11-08T12:00:00Z'));
    expect(r.cookie).toHaveBeenCalledWith('vrms_rt', 'tok', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: COOKIE_PATH,
      maxAge: 12 * 3600 * 1000,
    });
    jest.useRealTimers();
  });

  it('never sets a negative maxAge', () => {
    const r = res();
    setRefreshCookie(r, local, 't', new Date(Date.now() - 5000));
    expect(call(r)[2].maxAge).toBe(0);
  });

  it('clears the refresh cookie on the same path', () => {
    const r = res();
    clearRefreshCookie(r, hosted);
    expect(r.clearCookie).toHaveBeenCalledWith(
      '__Secure-vrms_rt',
      expect.objectContaining({ path: '/vrms/session', secure: true }),
    );
  });

  it('reads the refresh cookie, treating empty, missing and non string values as absent', () => {
    expect(readRefreshCookie(req({ vrms_rt: 'abc' }), local)).toBe('abc');
    expect(readRefreshCookie(req({ vrms_rt: '' }), local)).toBeNull();
    expect(readRefreshCookie(req({ vrms_rt: { a: 1 } }), local)).toBeNull();
    expect(readRefreshCookie(req(undefined), local)).toBeNull();
  });

  describe('login state cookie', () => {
    const login = {
      state: 'statevalue123',
      verifier: 'v'.repeat(43),
      returnTo: '/repairs?status=open#top',
    };

    it('keeps state, verifier and return path for 10 minutes', () => {
      const r = res();
      setLoginCookie(r, local, login);
      const [name, value, options] = call(r);
      expect(name).toBe('vrms_login_stateval');
      expect(options.maxAge).toBe(LOGIN_STATE_MS);
      expect(LOGIN_STATE_MS).toBe(600_000);
      expect(JSON.parse(Buffer.from(value, 'base64url').toString())).toEqual(
        login,
      );
    });

    it('round trips through read', () => {
      const r = res();
      setLoginCookie(r, local, login);
      const [name, value] = call(r);
      expect(
        readLoginCookie(req({ [name]: value }), local, login.state),
      ).toEqual(login);
    });

    it('answers null when the cookie is missing, tampered, not JSON or missing a field', () => {
      const name = loginCookieName(local, login.state);
      const b64 = (o: unknown) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      expect(readLoginCookie(req({}), local, login.state)).toBeNull();
      expect(
        readLoginCookie(
          req({ [name]: '%%%not-base64-json' }),
          local,
          login.state,
        ),
      ).toBeNull();
      expect(
        readLoginCookie(
          req({ [name]: b64({ state: 's', verifier: 'v' }) }),
          local,
          login.state,
        ),
      ).toBeNull();
      expect(
        readLoginCookie(
          req({ [name]: b64({ state: 1, verifier: 'v', returnTo: '/' }) }),
          local,
          login.state,
        ),
      ).toBeNull();
    });

    it("does not read another attempt's cookie", () => {
      const r = res();
      setLoginCookie(r, local, login);
      const [name, value] = call(r);
      expect(
        readLoginCookie(req({ [name]: value }), local, 'otherstate99'),
      ).toBeNull();
    });

    it('clears only its own attempt cookie', () => {
      const r = res();
      clearLoginCookie(r, local, login.state);
      expect((r.clearCookie.mock.calls[0] as string[])[0]).toBe(
        loginCookieName(local, login.state),
      );
    });
  });
});
