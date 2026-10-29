import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from './catalog';

// Spec 0011, AC-7: every route carries exactly one of these. A route with none is denied.
export const PERMISSION_KEY = 'permission';
export const AUTHENTICATED_KEY = 'authenticated';
export const PUBLIC_KEY = 'public';

/** The caller needs this key, or any one of a list of keys. */
export const RequirePermission = (
  ...keys: [PermissionKey, ...PermissionKey[]]
) => SetMetadata(PERMISSION_KEY, keys);

/** Any signed in VRMS user; no key needed. */
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);

/** No sign in at all. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
