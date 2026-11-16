import * as Sentry from '@sentry/nestjs';
import type { AuthUser } from '../auth/account-check';
import { SystemType } from '../auth/roles';

/**
 * VRMS spec 0025, AC-1: the signed in caller on this request's events, as an id and the role names
 * for VRMS only (never an email, a name, a permission key or an address). No VRMS role, no tag.
 * Sentry keeps one scope per request, so this never leaks into another caller's events.
 */
export function setSentryUser(user: AuthUser): void {
  Sentry.setUser({ id: user.sub });
  const roles = user.roles
    .filter((entry) => entry.system === SystemType.VRMS)
    .map((entry) => entry.role);
  Sentry.setTag('role', roles.length ? roles.join(',') : undefined);
}
