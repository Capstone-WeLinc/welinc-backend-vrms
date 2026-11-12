import { MATRIX_ROLES, PERMISSION_CATALOG } from '../catalog';
import { isAuthMatrix, matrixRows, type AuthMatrix } from './matrix-rows';

// Suite spec 0013, AC-29: welinc-auth's answer as VRMS's rows.

const answer = (
  grants: Record<string, string[]>,
  keys = ['ticket.view', 'fleet.fly'],
): AuthMatrix => ({
  system: 'VRMS',
  version: 7,
  permissions: keys.map((key) => ({ key, lockedRoles: [] })),
  grants,
});

describe('matrixRows (AC-29)', () => {
  it('writes one row per VRMS role and key, on only where granted', () => {
    const plan = matrixRows(answer({ ADMIN: ['ticket.view'], MECHANIC: [] }));
    if (plan.kind !== 'rows') throw new Error('expected rows');
    expect(plan.rows).toHaveLength(
      MATRIX_ROLES.length * PERMISSION_CATALOG.length,
    );
    expect(plan.rows.filter((r) => r.allowed)).toEqual([
      { role: 'ADMIN', permission: 'ticket.view', allowed: true },
    ]);
  });

  it('ignores a key VRMS does not check and counts a key welinc-auth lacks as off', () => {
    const plan = matrixRows(answer({ ADMIN: ['ticket.view', 'fleet.fly'] }));
    if (plan.kind !== 'rows') throw new Error('expected rows');
    expect(plan.unknownKeys).toEqual(['fleet.fly']);
    expect(plan.missingKeys).toContain('settings.manage');
    expect(plan.rows.some((r) => r.permission === 'fleet.fly')).toBe(false);
    expect(
      plan.rows.find(
        (r) => r.role === 'ADMIN' && r.permission === 'settings.manage',
      )?.allowed,
    ).toBe(false);
  });

  it('refuses a matrix where no role holds anything', () => {
    expect(matrixRows(answer({ ADMIN: [], MECHANIC: [] }))).toEqual({
      kind: 'empty',
    });
    expect(matrixRows(answer({}))).toEqual({ kind: 'empty' });
  });

  it('accepts only an answer with a version, permissions and grant lists', () => {
    expect(isAuthMatrix(answer({ ADMIN: [] }))).toBe(true);
    expect(
      isAuthMatrix({ version: 1, permissions: [], grants: { ADMIN: 'x' } }),
    ).toBe(false);
    expect(isAuthMatrix(null)).toBe(false);
  });
});
