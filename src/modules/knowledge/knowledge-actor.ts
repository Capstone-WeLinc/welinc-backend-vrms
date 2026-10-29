import { UserRole } from '../../auth/roles';

export type JwtUser = {
  sub: string;
  email: string;
  name: string;
  roles: { role: UserRole; system: string }[];
  system: string;
};

/** Editors (spec 0007, AC-3). The permission matrix (feature 5) takes these lists over. */
export const KNOWLEDGE_EDITORS = [UserRole.ADMIN, UserRole.CHIEF_MECHANIC];

function hasRole(user: JwtUser, roles: UserRole[]) {
  return user.roles.some(
    (r) => roles.includes(r.role) && r.system === user.system,
  );
}

/** Editors also see drafts, inactive entries, typical costs and recent tickets; a MECHANIC never does. */
export function isKnowledgeEditor(user: JwtUser) {
  return hasRole(user, KNOWLEDGE_EDITORS);
}
