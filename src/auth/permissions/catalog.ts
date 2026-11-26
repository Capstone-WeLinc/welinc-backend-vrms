import type { ModuleName } from '../../settings/catalog';
import { UserRole } from '../roles';

// Spec 0011, AC-1: the one list of permission keys VRMS code checks. Since suite spec 0013
// (AC-25, AC-30) each key's label, group, description, defaults and locks live in welinc-auth
// (prisma/catalog/vrms.ts), where suite admins edit the matrix; VRMS syncs a copy into
// role_permissions every 60 s. Here stay only the keys, the module that owns a key, and (in
// ability.factory.ts) the CASL rules.
//
// Rule for later features: a new action adds its key here and in welinc-auth's vrms.ts (Admin on
// and the other roles off unless its spec says otherwise), plus its CASL rule and its
// @RequirePermission. Until welinc-auth's matrix has it, the key counts as off.

export const MATRIX_ROLES = [
  UserRole.ADMIN,
  UserRole.CHIEF_MECHANIC,
  UserRole.MECHANIC,
] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

export type PermissionEntry = {
  key: string;
  /** Spec 0012, AC-10: while this module is off, the key is removed from every user. */
  module?: ModuleName;
};

export const PERMISSION_CATALOG = [
  { key: 'ticket.view' },
  { key: 'ticket.view_all' },
  { key: 'ticket.create' },
  { key: 'ticket.work' },
  { key: 'ticket.administer' },
  // Spec 0014, AC-5: Verify and Send back, never on a ticket the caller is assigned to
  { key: 'ticket.verify' },
  { key: 'ticket.costs.view' },
  { key: 'ticket.costs.edit' },
  // Spec 0019, AC-9: any open status, adding, removing or swapping
  { key: 'ticket.assign' },
  // Spec 0019, AC-1: details and issues after create; mechanics stay on ticket.assign
  { key: 'ticket.edit' },
  { key: 'ticket.unlock' },
  // Spec 0023, AC-1: follows the caller's ticket visibility (assigned only without ticket.view_all)
  { key: 'ticket.checklist.edit' },
  // Spec 0017, AC-15: follows the caller's ticket visibility
  { key: 'ticket.files.add' },
  // Spec 0017, AC-15: receipts and other documents also need ticket.costs.view
  { key: 'ticket.documents.add' },
  // Spec 0017, AC-15 and AC-17: everyone may still remove the files they added themselves
  { key: 'ticket.files.remove_any' },
  { key: 'ai.use', module: 'ai' },
  // Spec 0029, AC-11: VMMS referrals, BMS expedite requests and failed deliveries
  { key: 'integration.respond' },
  { key: 'audit.view' },
  { key: 'analytics.view', module: 'analytics' },
  { key: 'config.read' },
  // Spec 0022, AC-1: the Team section on the Chief dashboard and the reads behind it
  { key: 'mechanics.view' },
  // Spec 0016, AC-21: the Vehicles section in Settings
  { key: 'vehicle.manage' },
  { key: 'knowledge.view', module: 'knowledge' },
  { key: 'knowledge.suggest', module: 'knowledge' },
  { key: 'knowledge.edit', module: 'knowledge' },
  // Suite spec 0013, AC-30, AC-31: the Users page as a team and work view (was users.manage)
  { key: 'team.manage' },
  { key: 'settings.manage' },
  { key: 'lookups.manage' },
] as const satisfies readonly PermissionEntry[];

export type PermissionKey = (typeof PERMISSION_CATALOG)[number]['key'];

const BY_KEY = new Map<string, PermissionEntry>(
  PERMISSION_CATALOG.map((entry) => [entry.key, entry]),
);

export function catalogEntry(key: string): PermissionEntry | undefined {
  return BY_KEY.get(key);
}

export function isMatrixRole(role: string): role is MatrixRole {
  return (MATRIX_ROLES as readonly string[]).includes(role);
}
