import type { AppAbility } from '../../auth/permissions/ability.factory';
import { UserRole } from '../../auth/roles';

export type JwtUser = {
  sub: string;
  email: string;
  name: string;
  roles: { role: UserRole; system: string }[];
  system: string;
};

/**
 * knowledge.edit (spec 0011, AC-13): sees drafts, inactive entries, typical costs and recent
 * tickets. A knowledge.view reader never does.
 */
export function editsKnowledge(ability: AppAbility) {
  return ability.can('edit', 'KnowledgeEntry');
}
