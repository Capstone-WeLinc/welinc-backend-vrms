import type { AuthUser } from '../account-check';
import { AppAbility, buildAbility } from './ability.factory';
import {
  isMatrixRole,
  PERMISSION_CATALOG,
  type PermissionKey,
} from './catalog';
import type { PermissionsService } from './permissions.service';

type Caller = Pick<AuthUser, 'sub' | 'roles'>;

/** The keys the default matrix grants these roles, as a fresh database would hold them. */
export function defaultKeys(roles: readonly string[]): Set<PermissionKey> {
  const held = roles.filter(isMatrixRole);
  return new Set(
    PERMISSION_CATALOG.filter((entry) =>
      held.some((role) => entry.defaults[role]),
    ).map((entry) => entry.key),
  );
}

/** A caller's ability under the default matrix. */
export function defaultAbility(user: Caller): AppAbility {
  return buildAbility(user.sub, defaultKeys(user.roles.map((r) => r.role)));
}

/** Stands in for PermissionsService with the default matrix loaded. */
export class FakePermissions implements Pick<
  PermissionsService,
  'ensureFresh' | 'keysFor' | 'abilityFor' | 'isReady' | 'currentVersion'
> {
  readonly isReady = true;
  readonly currentVersion = 1;

  ensureFresh() {
    return Promise.resolve();
  }

  keysFor(roles: readonly string[]) {
    return defaultKeys(roles);
  }

  abilityFor(user: Caller) {
    return defaultAbility(user);
  }
}
