import { MATRIX_ROLES, PERMISSION_CATALOG } from '../catalog';

// Suite spec 0013, AC-29: welinc-auth's matrix answer as VRMS's role_permissions rows. Pure, so
// the drift and empty rules are tested without a database.

/** `GET /auth/permissions/VRMS` (AC-26). */
export type AuthMatrix = {
  system: string;
  version: number;
  permissions: { key: string; lockedRoles: string[] }[];
  grants: Record<string, string[]>;
};

export type MatrixRowsPlan =
  | { kind: 'empty' }
  | {
      kind: 'rows';
      /** One row per VRMS role and VRMS key: a key welinc-auth lacks counts as off. */
      rows: { role: string; permission: string; allowed: boolean }[];
      /** Keys welinc-auth sent that VRMS code doesn't check (ignored). */
      unknownKeys: string[];
      /** Keys VRMS checks that welinc-auth didn't send (off). */
      missingKeys: string[];
    };

/** The answer in the shape the sync accepts; anything else is treated as unreadable. */
export function isAuthMatrix(value: unknown): value is AuthMatrix {
  const v = value as Partial<AuthMatrix> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.version === 'number' &&
    Array.isArray(v.permissions) &&
    typeof v.grants === 'object' &&
    v.grants !== null &&
    Object.values(v.grants).every((keys) => Array.isArray(keys))
  );
}

export function matrixRows(answer: AuthMatrix): MatrixRowsPlan {
  // AC-29: an empty matrix (no role holds anything) would lock everyone out, so it is refused
  if (Object.values(answer.grants).every((keys) => keys.length === 0))
    return { kind: 'empty' };

  const ours = new Set<string>(PERMISSION_CATALOG.map((e) => e.key));
  const sent = new Set(answer.permissions.map((p) => p.key));
  const rows = MATRIX_ROLES.flatMap((role) => {
    const held = new Set(answer.grants[role] ?? []);
    return PERMISSION_CATALOG.map((entry) => ({
      role,
      permission: entry.key,
      allowed: held.has(entry.key),
    }));
  });
  return {
    kind: 'rows',
    rows,
    unknownKeys: [...sent].filter((key) => !ours.has(key)).sort(),
    missingKeys: [...ours].filter((key) => !sent.has(key)).sort(),
  };
}
