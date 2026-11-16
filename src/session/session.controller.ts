import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { AccountCheck } from '../auth/account-check';
import {
  Authenticated,
  Public,
} from '../auth/permissions/permission.decorators';
import {
  authUnavailable,
  checkPerson,
  sessionEnded,
  TOKEN_VERIFIER,
  TokenVerifier,
} from '../auth/verify';
import { AuthClient, type UserGrant } from './auth-client';
import {
  clearLoginCookie,
  clearRefreshCookie,
  readLoginCookie,
  readRefreshCookie,
  setLoginCookie,
  setRefreshCookie,
} from './cookies';
import { SessionCsrfGuard } from './csrf.guard';
import { SESSION_CONFIG, type SessionConfig } from './session.config';
import { ApiTags } from '@nestjs/swagger';
import {
  ApiCookieRoute,
  ApiGenericErrors,
  ApiNoErrors,
  ApiUserToken,
  ApiVrmsSession,
} from '../openapi/decorators';

/** Our own `state` values: 32 random bytes, base64url (spec 0003, Value sourcing). */
const STATE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const random = () => randomBytes(32).toString('base64url');

/**
 * Keeps `return` only when it resolves to the VRMS web address itself, else `/` (spec 0001
 * section 7, step 3), so the login can never send the browser somewhere else.
 */
export function safeReturnPath(raw: unknown, webAppUrl: string): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > 2048) return '/';
  try {
    const base = new URL(webAppUrl);
    const resolved = new URL(raw, `${base.origin}/`);
    if (resolved.origin !== base.origin) return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * VRMS's session routes (spec 0001 section 7, spec 0003 AC-16, AC-16a): the reference other
 * systems copy. The web app never sees a code or a refresh token.
 */
@ApiTags('Session')
@ApiGenericErrors()
@Controller('vrms/session')
export class SessionController {
  constructor(
    @Inject(SESSION_CONFIG) private readonly config: SessionConfig,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    private readonly auth: AuthClient,
    private readonly accountCheck: AccountCheck,
  ) {}

  /** Starts a login: a state, a PKCE verifier and the return path, then `/auth/authorize`. */
  @ApiNoErrors()
  @Public()
  @Get('start')
  start(@Query('return') returnTo: unknown, @Res() res: Response) {
    const state = random();
    const verifier = random();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    setLoginCookie(res, this.config, {
      state,
      verifier,
      returnTo: safeReturnPath(returnTo, this.config.webAppUrl),
    });
    const url = new URL(`${this.config.authPublicUrl}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(HttpStatus.FOUND, url.toString());
  }

  /**
   * The login comes back. The state cookie is checked and cleared before welinc-auth is
   * called, so a retried or prefetched callback fails as `LOGIN_STATE_INVALID` (AC-15).
   */
  @ApiNoErrors()
  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
    @Query('error_description') errorDescription: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const fail = (reason: string, extra: Record<string, string> = {}) =>
      res.redirect(HttpStatus.FOUND, this.portalError(reason, extra));

    if (typeof state !== 'string' || !STATE_SHAPE.test(state)) {
      return fail('LOGIN_STATE_INVALID');
    }
    const login = readLoginCookie(req, this.config, state);
    clearLoginCookie(res, this.config, state);
    if (!login || !sameText(login.state, state)) {
      return fail('LOGIN_STATE_INVALID');
    }
    if (error !== undefined) {
      if (error !== 'access_denied') return fail('LOGIN_FAILED');
      // Suite spec 0014, AC-3: roles held here, but for the phone app. `system` is this
      // system's own upper case code in every copy (VRMS, VMMS, BMS)
      return errorDescription === 'APP_NOT_ALLOWED'
        ? fail('APP_NOT_ALLOWED', { system: 'VRMS' })
        : fail('NO_SYSTEM_ACCESS', { system: 'VRMS' });
    }
    if (typeof code !== 'string' || code === '') return fail('LOGIN_FAILED');

    const result = await this.auth.exchangeCode(
      code,
      login.verifier,
      req.ip ?? null,
    );
    if (result.kind === 'no_access') {
      return fail('NO_SYSTEM_ACCESS', { system: 'VRMS' });
    }
    if (result.kind === 'not_allowed') {
      return fail('APP_NOT_ALLOWED', { system: 'VRMS' });
    }
    if (result.kind !== 'ok') return fail('LOGIN_FAILED');
    this.setCookie(res, result.grant);
    return res.redirect(
      HttpStatus.FOUND,
      `${this.config.webAppUrl}${login.returnTo}`,
    );
  }

  /** Swaps the refresh cookie for an access token, rotating the cookie (AC-16, AC-16a). */
  @ApiVrmsSession()
  @ApiCookieRoute()
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionCsrfGuard)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const token = readRefreshCookie(req, this.config);
    if (!token) throw sessionEnded();
    const result = await this.auth.refresh(token, req.ip ?? null);
    if (result.kind === 'ended') {
      clearRefreshCookie(res, this.config);
      throw sessionEnded();
    }
    if (result.kind === 'no_access') {
      clearRefreshCookie(res, this.config);
      throw new HttpException(
        {
          statusCode: HttpStatus.FORBIDDEN,
          message: 'This account has no access to VRMS',
          error: 'Forbidden',
          code: 'NO_SYSTEM_ACCESS',
        },
        HttpStatus.FORBIDDEN,
      );
    }
    // Suite spec 0014, AC-3: a role change moved this person to the phone app
    if (result.kind === 'not_allowed') {
      clearRefreshCookie(res, this.config);
      throw new HttpException(
        {
          statusCode: HttpStatus.FORBIDDEN,
          message: 'Your role in VRMS uses the WeLinc mobile app, not the web',
          error: 'Forbidden',
          code: 'APP_NOT_ALLOWED',
        },
        HttpStatus.FORBIDDEN,
      );
    }
    if (result.kind === 'unavailable') throw authUnavailable();

    const { grant } = result;
    this.setCookie(res, grant);
    return {
      accessToken: grant.accessToken,
      expiresIn: grant.expiresIn,
      sessionExpiresAt: grant.sessionExpiresAt,
      // The 12 hour end, so the app can tell a max age cutoff from an idle one (AC-23)
      sessionAbsoluteExpiresAt: grant.sessionAbsoluteExpiresAt,
      user: grant.user,
    };
  }

  /**
   * A real input ping from the app (AC-22): passed to `/auth/session/activity`. The app sends
   * it at most once a minute; welinc-auth ignores more than 2 a minute per session.
   */
  @ApiVrmsSession()
  @ApiCookieRoute()
  @Public()
  @Post('activity')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionCsrfGuard)
  async activity(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const token = readRefreshCookie(req, this.config);
    if (!token) throw sessionEnded();
    const result = await this.auth.activity(token, req.ip ?? null);
    if (result === 'ended') {
      clearRefreshCookie(res, this.config);
      throw sessionEnded();
    }
    if (result === 'unavailable') throw authUnavailable();
  }

  /**
   * Logout (AC-24, AC-42). Always clears `vrms_rt`. The session is ended by the cookie's token,
   * or by the access token's `sid` when the cookie's token matches nothing at welinc-auth. If
   * welinc-auth can't be reached it answers 503, so the app can offer a retry, which still
   * works through the access token's `sid`.
   */
  @ApiVrmsSession()
  @ApiCookieRoute()
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SessionCsrfGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const refreshToken = readRefreshCookie(req, this.config);
    clearRefreshCookie(res, this.config);
    const sid = await this.bearerSid(req);
    const result = await this.auth.logout(
      { refreshToken, sid },
      req.ip ?? null,
    );
    if (sid) this.accountCheck.forget(sid);
    if (result === 'unavailable') throw authUnavailable();
  }

  /** The server's own cutoff, asked fresh, for the idle warning (AC-23, AC-26). */
  @ApiUserToken()
  @Authenticated()
  @Get('status')
  async status(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const { raw, token } = await checkPerson(this.verifier, req);
    return this.accountCheck.status(raw, token);
  }

  /** The `sid` of a valid VRMS user token on the request, else null. Never throws. */
  private async bearerSid(req: Request): Promise<string | null> {
    try {
      const { token } = await checkPerson(this.verifier, req);
      return token.sid;
    } catch {
      return null;
    }
  }

  private setCookie(res: Response, grant: UserGrant) {
    // AC-16: the cookie lives to the absolute end; with none (never for web), the idle bound one
    const end = new Date(
      grant.sessionAbsoluteExpiresAt ?? grant.sessionExpiresAt,
    );
    setRefreshCookie(res, this.config, grant.refreshToken, end);
  }

  private portalError(code: string, extra: Record<string, string>): string {
    const url = new URL(`${this.config.portalUrl}/`);
    url.search = new URLSearchParams({ error: code, ...extra }).toString();
    return url.toString();
  }
}
