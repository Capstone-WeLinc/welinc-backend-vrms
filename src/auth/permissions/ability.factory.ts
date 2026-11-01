import { Ability, AbilityBuilder } from '@casl/ability';
import { createPrismaAbility, PrismaQuery, Subjects } from '@casl/prisma';
import type {
  IssueCategory,
  KnowledgeEntry,
  KnowledgeSuggestion,
  RepairTicket,
} from '@prisma/client';
import type { PermissionKey } from './catalog';

// Spec 0011, CASL rules per key. Action names avoid `manage`, which CASL reads as "any action".
export type TicketAction =
  | 'read'
  | 'create'
  | 'work'
  | 'administer'
  | 'verify'
  | 'editCosts'
  | 'unlock'
  | 'assign'
  | 'addFiles'
  | 'addDocuments'
  | 'removeAny';
export type AppAction = TicketAction | 'edit' | 'review' | PermissionKey;

export type AppSubjects =
  | Subjects<{
      RepairTicket: RepairTicket;
      KnowledgeEntry: KnowledgeEntry;
      IssueCategory: IssueCategory;
      KnowledgeSuggestion: KnowledgeSuggestion;
    }>
  | 'Permission';

export type AppAbility = Ability<[AppAction, AppSubjects], PrismaQuery>;

export const COST_FIELDS = ['partsCost', 'laborCost', 'totalCost'] as const;

/** Whether the caller holds ticket.costs.view, for money outside a ticket (spec 0013, AC-5). */
export function canViewCosts(ability: AppAbility): boolean {
  return ability.can('ticket.costs.view', 'Permission');
}

/**
 * Builds one caller's ability from their granted keys. Built per request and never shared,
 * because the ownership conditions carry the caller's own id (AC-9).
 */
export function buildAbility(
  userId: string,
  keys: ReadonlySet<PermissionKey>,
): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(
    createPrismaAbility,
  );
  const mine = {
    assignments: { some: { mechanic: { is: { authUserId: userId } } } },
  };

  for (const key of keys) {
    // The flag @RequirePermission checks
    can(key, 'Permission');

    switch (key) {
      case 'ticket.view':
        can('read', 'RepairTicket', mine);
        break;
      case 'ticket.view_all':
        can('read', 'RepairTicket');
        break;
      case 'ticket.create':
        can('create', 'RepairTicket');
        break;
      case 'ticket.work':
        can('work', 'RepairTicket', mine);
        break;
      case 'ticket.administer':
        can('administer', 'RepairTicket');
        break;
      case 'ticket.verify':
        can('verify', 'RepairTicket');
        break;
      case 'ticket.costs.edit':
        can('editCosts', 'RepairTicket');
        break;
      case 'ticket.assign':
        // Spec 0016, AC-16: a global right, like administer; not per assignment
        can('assign', 'RepairTicket');
        break;
      case 'ticket.unlock':
        can('unlock', 'RepairTicket');
        break;
      case 'ticket.files.add':
        // Spec 0017, AC-15: everywhere the caller sees every ticket, else on their assigned ones
        if (keys.has('ticket.view_all')) can('addFiles', 'RepairTicket');
        else can('addFiles', 'RepairTicket', mine);
        break;
      case 'knowledge.view':
        can('read', 'KnowledgeEntry', { status: 'ACTIVE' });
        break;
      case 'knowledge.edit':
        can('read', 'KnowledgeEntry');
        can('edit', 'KnowledgeEntry');
        can('review', 'KnowledgeSuggestion');
        break;
      case 'lookups.manage':
        can('edit', 'IssueCategory');
        break;
      case 'knowledge.suggest':
        can('create', 'KnowledgeSuggestion');
        break;
    }
  }

  // After every can rule, since in CASL a later rule wins.
  // Spec 0014, AC-6: nobody verifies a ticket they are assigned to, with the same ownership
  // condition as ticket.work
  cannot('verify', 'RepairTicket', mine);
  if (!keys.has('ticket.costs.view')) {
    cannot('read', 'RepairTicket', [...COST_FIELDS]);
  }

  return build();
}
