import {
  authUnavailable,
  AUTH_UNAVAILABLE_MESSAGE,
  invalidSession,
  wrongAudience,
  wrongTokenUse,
} from './errors';

// covers: spec 0002 AC-8 (WRONG_AUDIENCE), AC-12 (503 never 401), AC-19 (WRONG_TOKEN_USE)
describe('auth errors', () => {
  it('answers an invalid token with a plain 401 and no code', () => {
    const error = invalidSession();

    expect(error.getStatus()).toBe(401);
    expect(error.getResponse()).toEqual({
      statusCode: 401,
      message: 'Invalid session',
      error: 'Unauthorized',
    });
  });

  it('tells a token for another system apart with WRONG_AUDIENCE', () => {
    const error = wrongAudience();

    expect(error.getStatus()).toBe(401);
    expect(error.getResponse()).toMatchObject({ code: 'WRONG_AUDIENCE' });
  });

  it('answers the wrong kind of token with 403 WRONG_TOKEN_USE', () => {
    const error = wrongTokenUse();

    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toMatchObject({
      code: 'WRONG_TOKEN_USE',
      error: 'Forbidden',
    });
  });

  it('accepts a custom message for the wrong token use', () => {
    expect(wrongTokenUse('Services only').getResponse()).toMatchObject({
      message: 'Services only',
    });
  });

  it('answers an unreachable auth service with 503, never 401', () => {
    const error = authUnavailable();

    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({
      message: AUTH_UNAVAILABLE_MESSAGE,
      code: 'AUTH_UNAVAILABLE',
      error: 'Service Unavailable',
    });
  });
});
