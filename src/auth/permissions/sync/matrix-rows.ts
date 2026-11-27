import { PERMISSION_CATALOG } from '../catalog';

// Suite spec 0013, AC-29: welinc-auth's matrix answer as VRMS's role_permissions rows. Pure, so
// the drift and empty rules are tested without a database.

/** welinc-auth's role code rule; `role_permissions.role` is varchar(30), so longer codes are skipped. */
export const ROLE_CODE_RE = /^[A-Z][A-Z0-9_]{1,29}$/;

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
      /**
       * One row per role in the answer (custom roles included, suite spec 0018 child 0002 AC-32)
       * and per VRMS key welinc-auth sent. A key it didn't send gets no row, so it counts as off
       * (a missing row denies) and VRMS can tell it was never synced (child 0002, AC-33).
       */
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
  const keys = PERMISSION_CATALOG.filter((entry) => sent.has(entry.key));
  const rows = Object.keys(answer.grants)
    .filter((role) => ROLE_CODE_RE.test(role))
    .sort()
    .flatMap((role) => {
      const held = new Set(answer.grants[role]);
      return keys.map((entry) => ({
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
