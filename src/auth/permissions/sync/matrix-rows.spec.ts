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
  it('writes one row per role in the answer and per VRMS key it sent, on only where granted', () => {
    const plan = matrixRows(answer({ ADMIN: ['ticket.view'], MECHANIC: [] }));
    if (plan.kind !== 'rows') throw new Error('expected rows');
    // 2 roles x the 1 VRMS key sent (fleet.fly isn't one)
    expect(plan.rows).toHaveLength(2);
    expect(plan.rows.filter((r) => r.allowed)).toEqual([
      { role: 'ADMIN', permission: 'ticket.view', allowed: true },
    ]);
  });

  it('ignores a key VRMS does not check and writes no row for a key welinc-auth lacks', () => {
    const plan = matrixRows(answer({ ADMIN: ['ticket.view', 'fleet.fly'] }));
    if (plan.kind !== 'rows') throw new Error('expected rows');
    expect(plan.unknownKeys).toEqual(['fleet.fly']);
    expect(plan.missingKeys).toContain('settings.manage');
    expect(plan.rows.some((r) => r.permission === 'fleet.fly')).toBe(false);
    // No row: it counts as off (a missing row denies), and reads as never synced
    expect(plan.rows.some((r) => r.permission === 'settings.manage')).toBe(
      false,
    );
  });

  // covers: suite spec 0018 child 0002 AC-32
  it('writes cells for every role the answer names, custom ones included, and skips bad codes', () => {
    const plan = matrixRows(
      answer(
        {
          ADMIN: ['ticket.view'],
          C_TIRE_SPECIALIST: ['ticket.view'],
          'not a code': ['ticket.view'],
          C_THIS_CODE_IS_FAR_TOO_LONG_TO_STORE: ['ticket.view'],
        },
        ['ticket.view'],
      ),
    );
    if (plan.kind !== 'rows') throw new Error('expected rows');
    expect(plan.rows).toEqual([
      { role: 'ADMIN', permission: 'ticket.view', allowed: true },
      { role: 'C_TIRE_SPECIALIST', permission: 'ticket.view', allowed: true },
    ]);
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
