import type { ModuleName } from '../../settings/catalog';
import { UserRole } from '../roles';

// Spec 0011, AC-1: the one definition of permission keys. Each role's on or off lives in
// role_permissions; these defaults only seed missing rows (AC-3). A locked cell always takes
// its value from here, whatever its row says (AC-4).
//
// Rule for later features: a new action adds its key here with Admin on and the other roles
// off, unless its own spec says otherwise, plus its CASL rule and its @RequirePermission.

export const MATRIX_ROLES = [
  UserRole.ADMIN,
  UserRole.CHIEF_MECHANIC,
  UserRole.MECHANIC,
] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

export const ROLE_LABELS: Record<MatrixRole, string> = {
  ADMIN: 'Admin',
  CHIEF_MECHANIC: 'Chief Mechanic',
  MECHANIC: 'Mechanic',
};

export type PermissionEntry = {
  key: string;
  label: string;
  group: 'Tickets' | 'Records' | 'Knowledge' | 'Admin';
  description: string;
  defaults: Record<MatrixRole, boolean>;
  /** A locked role always has its default; no edit or database row changes it. */
  locked?: Partial<Record<MatrixRole, true>>;
  /** Spec 0012, AC-10: while this module is off, the key is removed from every user. */
  module?: ModuleName;
};

const ALL_LOCKED = {
  ADMIN: true,
  CHIEF_MECHANIC: true,
  MECHANIC: true,
} as const;

export const PERMISSION_CATALOG = [
  {
    key: 'ticket.view',
    label: 'See tickets assigned to you',
    group: 'Tickets',
    description: 'Open and list the repair tickets you are assigned to.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: true },
  },
  {
    key: 'ticket.view_all',
    label: 'See every ticket',
    group: 'Tickets',
    description: 'Open and list every repair ticket, whoever is assigned.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: false },
  },
  {
    key: 'ticket.create',
    label: 'Create tickets and pick mechanics',
    group: 'Tickets',
    description: 'Open new repair tickets and assign mechanics to them.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
  },
  {
    key: 'ticket.work',
    label: 'Work your assigned tickets (status, steps, knowledge link)',
    group: 'Tickets',
    description:
      'Start work and send for verification, tick steps and link known fixes on your own tickets.',
    defaults: { ADMIN: false, CHIEF_MECHANIC: true, MECHANIC: true },
  },
  {
    key: 'ticket.administer',
    label: 'Cancel tickets and make work moves on any ticket',
    group: 'Tickets',
    description:
      'Cancel any open ticket, start work and send for verification on any ticket, and change its steps and known fixes.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
  },
  {
    // Spec 0014, AC-5: Verify and Send back, never on a ticket the caller is assigned to
    key: 'ticket.verify',
    label: 'Verify or send back finished work',
    group: 'Tickets',
    description:
      'Close a ticket that is waiting for verification, or send it back with a comment. Never on a ticket you are assigned to.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: false },
  },
  {
    key: 'ticket.costs.view',
    label: 'See costs',
    group: 'Tickets',
    description: 'See parts, labor and total costs on tickets and in history.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: false },
  },
  {
    key: 'ticket.costs.edit',
    label: 'Encode costs',
    group: 'Tickets',
    description: 'Enter or change the costs of a ticket.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
  },
  {
    key: 'ticket.assign',
    label: 'Assign mechanics',
    group: 'Tickets',
    // Spec 0019, AC-9: any open status, adding, removing or swapping
    description:
      'Add, remove or swap the in house mechanics on any open ticket.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: false },
  },
  {
    // Spec 0019, AC-1: details and issues after create; mechanics stay on ticket.assign
    key: 'ticket.edit',
    label: 'Edit ticket details and issues',
    group: 'Tickets',
    description:
      'Fix the driver, odometer, priority and account of a ticket, and add, reword or remove its issues.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
  },
  {
    key: 'ticket.unlock',
    label: 'Unlock closed tickets',
    group: 'Tickets',
    description: 'Reopen a closed or cancelled ticket for corrections.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
  },
  {
    // Spec 0023, AC-1: follows the caller's ticket visibility (assigned only without ticket.view_all)
    key: 'ticket.checklist.edit',
    label: 'Edit ticket checklists',
    group: 'Tickets',
    description:
      "Add, reword, remove and reorder the steps on a ticket's issues. Without See every ticket, only on tickets assigned to you.",
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: true },
  },
  {
    // Spec 0017, AC-15: follows the caller's ticket visibility (assigned only without ticket.view_all)
    key: 'ticket.files.add',
    label: 'Add vehicle photos and proof',
    group: 'Tickets',
    description:
      'Add vehicle photos and proof of completion on the tickets you can see.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: true },
  },
  {
    // Spec 0017, AC-15: receipts and other documents also need ticket.costs.view
    key: 'ticket.documents.add',
    label: 'Add receipts and other documents',
    group: 'Tickets',
    description:
      'Add receipts and other documents on the tickets you can see. Needs See costs too.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: false },
  },
  {
    // Spec 0017, AC-15 and AC-17: everyone may still remove the files they added themselves
    key: 'ticket.files.remove_any',
    label: 'Remove anyone’s files',
    group: 'Tickets',
    description:
      'Remove photos, proof and documents that someone else added, on the tickets you can see.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: false },
    locked: { MECHANIC: true },
  },
  {
    key: 'ai.use',
    label: 'Use AI diagnosis',
    group: 'Tickets',
    description: 'Run AI diagnoses on tickets you can read, and rate them.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: true },
    module: 'ai',
  },
  {
    key: 'audit.view',
    label: 'See the audit log',
    group: 'Records',
    description: 'Read the audit timeline of every ticket.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
  },
  {
    key: 'analytics.view',
    label: 'See the Analytics page',
    group: 'Records',
    description: 'Open the analytics dashboards and AI insights.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
    module: 'analytics',
  },
  {
    key: 'config.read',
    label: 'Read garages, vehicles, drivers and mechanics',
    group: 'Records',
    description: 'Read the garage, vehicle, driver and mechanic lists.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: true },
  },
  {
    // Spec 0022, AC-1: the Team section on the Chief dashboard and the two reads behind it
    key: 'mechanics.view',
    label: "See the team's workload",
    group: 'Records',
    description:
      'See the Team section on the dashboard: who holds which tickets, and their open tickets.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: false },
  },
  {
    // Spec 0016, AC-21: the Vehicles section in Settings
    key: 'vehicle.manage',
    label: 'Manage vehicles',
    group: 'Records',
    description: 'Set a vehicle type on each truck in Settings.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
  },
  {
    key: 'knowledge.view',
    label: 'Read the fix library',
    group: 'Knowledge',
    description: 'Read the active entries of the fix library.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: true },
    module: 'knowledge',
  },
  {
    key: 'knowledge.suggest',
    label: 'Suggest a fix library entry',
    group: 'Knowledge',
    description: 'Send a suggestion for a new or changed entry.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: true },
    module: 'knowledge',
  },
  {
    key: 'knowledge.edit',
    label: 'Edit the fix library and review suggestions',
    group: 'Knowledge',
    description: 'Write entries, see drafts and costs, and review suggestions.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: false },
    module: 'knowledge',
  },
  {
    key: 'users.manage',
    label: 'Manage users',
    group: 'Admin',
    description: 'Add, edit and deactivate VRMS users.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
    locked: ALL_LOCKED,
  },
  {
    // Suite spec 0013, AC-31: the Users page as a team and work view. Account actions moved to
    // the portal; slice 5 moves this entry's label and defaults to welinc-auth's catalog.
    key: 'team.manage',
    label: 'Manage the team',
    group: 'Admin',
    description:
      'See everyone in VRMS with their open work, and unassign or reassign their tickets.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
    // Admin always keeps it, so no matrix edit hides the team from every admin
    locked: { ADMIN: true },
  },
  {
    key: 'permissions.manage',
    label: 'View and change permissions',
    group: 'Admin',
    description: 'See and change what each role may do.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
    locked: ALL_LOCKED,
  },
  {
    key: 'settings.manage',
    label: 'Change settings and modules',
    group: 'Admin',
    description:
      'Change thresholds, turn modules on or off, and read the change history.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: false, MECHANIC: false },
    // Admin always keeps it, so no matrix edit locks everyone out of Settings
    locked: { ADMIN: true },
  },
  {
    key: 'lookups.manage',
    label: 'Edit lookup lists',
    group: 'Admin',
    description:
      'Add, rename and deactivate issue categories, vehicle types and corporations.',
    defaults: { ADMIN: true, CHIEF_MECHANIC: true, MECHANIC: false },
  },
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

export function isLocked(entry: PermissionEntry, role: MatrixRole): boolean {
  return entry.locked?.[role] === true;
}
