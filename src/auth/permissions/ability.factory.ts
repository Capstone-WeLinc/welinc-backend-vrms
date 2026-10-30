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
  | 'editCosts'
  | 'unlock';
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
      case 'ticket.costs.edit':
        can('editCosts', 'RepairTicket');
        break;
      case 'ticket.unlock':
        can('unlock', 'RepairTicket');
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

  // After every can rule, since in CASL a later rule wins
  if (!keys.has('ticket.costs.view')) {
    cannot('read', 'RepairTicket', [...COST_FIELDS]);
  }

  return build();
}
