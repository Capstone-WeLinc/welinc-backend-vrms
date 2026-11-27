import type { AuthUser } from '../account-check';
import { AppAbility, buildAbility } from './ability.factory';
import { isMatrixRole, type MatrixRole, type PermissionKey } from './catalog';
import type { PermissionsService } from './permissions.service';

type Caller = Pick<AuthUser, 'sub' | 'roles'>;

// Test double. Since suite spec 0013 (AC-25, AC-30) the real defaults live in welinc-auth's
// prisma/catalog/vrms.ts and reach VRMS through the matrix sync. This is a copy of them, so route
// and ability tests run against the matrix a fresh suite starts with; keep it in step with that
// file when a key's defaults change. [Admin, Chief Mechanic, Mechanic]
const DEFAULTS: Record<PermissionKey, [boolean, boolean, boolean]> = {
  'ticket.view': [true, true, true],
  'ticket.view_all': [true, true, false],
  'ticket.create': [true, false, false],
  'ticket.work': [false, true, true],
  'ticket.administer': [true, false, false],
  'ticket.verify': [true, true, false],
  'ticket.costs.view': [true, true, false],
  'ticket.costs.edit': [true, false, false],
  'ticket.assign': [true, true, false],
  'ticket.edit': [true, false, false],
  'ticket.due_date.edit': [true, true, false],
  'ticket.unlock': [true, false, false],
  'ticket.checklist.edit': [true, true, true],
  'ticket.files.add': [true, true, true],
  'ticket.documents.add': [true, true, false],
  'ticket.files.remove_any': [true, true, false],
  'ai.use': [true, true, true],
  'integration.respond': [true, false, false],
  'audit.view': [true, false, false],
  'analytics.view': [true, false, false],
  'config.read': [true, true, true],
  'mechanics.view': [true, true, false],
  'vehicle.manage': [true, false, false],
  'knowledge.view': [true, true, true],
  'knowledge.suggest': [true, true, true],
  'knowledge.edit': [true, true, false],
  'team.manage': [true, false, false],
  'settings.manage': [true, false, false],
  'lookups.manage': [true, true, false],
};

const COLUMN: Record<MatrixRole, 0 | 1 | 2> = {
  ADMIN: 0,
  CHIEF_MECHANIC: 1,
  MECHANIC: 2,
};

/** The keys the default matrix grants these roles, as a fresh suite would hold them. */
export function defaultKeys(roles: readonly string[]): Set<PermissionKey> {
  const held = roles.filter(isMatrixRole);
  return new Set(
    (Object.keys(DEFAULTS) as PermissionKey[]).filter((key) =>
      held.some((role) => DEFAULTS[key][COLUMN[role]]),
    ),
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
