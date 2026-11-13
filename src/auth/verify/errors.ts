import { HttpException, HttpStatus } from '@nestjs/common';

/** The message every service shows while welinc-auth can't be reached. */
export const AUTH_UNAVAILABLE_MESSAGE =
  'Sign in service unavailable. Try again in a moment.';

const NAMES: Record<number, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  503: 'Service Unavailable',
};

/** Nest's usual body plus an optional stable `code` (spec 0001 section 11). */
function error(status: HttpStatus, message: string, code?: string) {
  return new HttpException(
    {
      statusCode: status,
      message,
      error: NAMES[status],
      ...(code ? { code } : {}),
    },
    status,
  );
}

/** A token that fails any check other than its audience. */
export const invalidSession = () =>
  error(HttpStatus.UNAUTHORIZED, 'Invalid session');

/** A good token past its `exp` (spec 0003, AC-27): refresh and try once more. */
export const tokenExpired = () =>
  error(
    HttpStatus.UNAUTHORIZED,
    'The access token has expired',
    'TOKEN_EXPIRED',
  );

/** The session is over: logout, idle, age, or an admin (spec 0001 section 11). */
export const sessionEnded = (
  message = 'The session has ended',
  code = 'SESSION_ENDED',
) => error(HttpStatus.UNAUTHORIZED, message, code);

/** A good signature, but the token is for another system. */
export const wrongAudience = () =>
  error(
    HttpStatus.UNAUTHORIZED,
    'This token is for another system',
    'WRONG_AUDIENCE',
  );

/** A service token on a route for people, or a person's token on a route for services. */
export const wrongTokenUse = (
  message = 'This route does not accept this token',
) => error(HttpStatus.FORBIDDEN, message, 'WRONG_TOKEN_USE');

/**
 * A service token without the route's scope (contract 0001 section 4, version 8; the directory's
 * rule too): 403 `FORBIDDEN`, so a caller can tell a missing grant from a wrong kind of token.
 */
export const missingScope = (scope: string) =>
  error(
    HttpStatus.FORBIDDEN,
    `This route needs the ${scope} scope`,
    'FORBIDDEN',
  );

/** welinc-auth's keys can't be reached and no usable copy is left. Never a 401. */
export const authUnavailable = () =>
  error(
    HttpStatus.SERVICE_UNAVAILABLE,
    AUTH_UNAVAILABLE_MESSAGE,
    'AUTH_UNAVAILABLE',
  );
