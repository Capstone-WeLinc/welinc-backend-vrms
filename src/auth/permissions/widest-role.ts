// Suite spec 0018 child 0002, AC-34: when a person holds several VRMS roles, the one recorded (the
// audit trail's actorRole, the roster's role) is the role with the most allowed keys; ties go to a
// built in role before a custom one, then by code. Nothing here names a role code.
//
// The key counts come from the loaded matrix: PermissionsService calls setRoleWeights on every
// reload, so this pure rule needs no service. Before the first load every role weighs 0 and the tie
// rule decides.

/** welinc-auth's prefix for custom role codes (suite spec 0018 child 0002, AC-30). */
export const CUSTOM_ROLE_PREFIX = 'C_';

let weights: ReadonlyMap<string, number> = new Map();

/** The number of allowed keys per role, from the last matrix load. */
export function setRoleWeights(next: ReadonlyMap<string, number>): void {
  weights = next;
}

export function isCustomRole(code: string): boolean {
  return code.startsWith(CUSTOM_ROLE_PREFIX);
}

/** The widest of `roles`, or null when there are none. */
export function widestRole(
  roles: readonly string[],
  weightOf: ReadonlyMap<string, number> = weights,
): string | null {
  let best: string | null = null;
  for (const role of new Set(roles)) {
    if (best === null || wider(role, best, weightOf)) best = role;
  }
  return best;
}

function wider(
  a: string,
  b: string,
  weightOf: ReadonlyMap<string, number>,
): boolean {
  const wa = weightOf.get(a) ?? 0;
  const wb = weightOf.get(b) ?? 0;
  if (wa !== wb) return wa > wb;
  if (isCustomRole(a) !== isCustomRole(b)) return !isCustomRole(a);
  return a < b;
}
