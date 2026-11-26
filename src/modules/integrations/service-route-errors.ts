import type { ErrorMap } from '../../openapi/decorators';

/**
 * Spec 0029 AC-24: what `requireService` answers on every `/vrms/integrations/*` route, before
 * the route's own codes (`src/auth/verify/errors.ts`). A wrong audience is 401, a person's token
 * or a missing scope or client is 403, and an unreachable key set is 503.
 */
export const SERVICE_ROUTE_ERRORS: ErrorMap = {
  401: [null, 'TOKEN_EXPIRED', 'WRONG_AUDIENCE'],
  403: ['WRONG_TOKEN_USE', 'FORBIDDEN'],
  503: ['AUTH_UNAVAILABLE'],
};

/** The 400 with no `code` that validation answers (a bad id, body or query). */
export const VALIDATION_ERROR: ErrorMap = { 400: [null] };
