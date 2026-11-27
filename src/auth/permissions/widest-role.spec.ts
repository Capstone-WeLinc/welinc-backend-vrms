import { widestRole } from './widest-role';

// covers: suite spec 0018 child 0002 AC-34 (the audit trail's actorRole and the roster's role)
describe('widestRole', () => {
  const weights = new Map([
    ['ADMIN', 25],
    ['CHIEF_MECHANIC', 14],
    ['MECHANIC', 8],
    ['C_NIGHT_LEAD', 14],
    ['C_TIRES', 8],
  ]);

  it('picks the role with the most allowed keys', () => {
    expect(widestRole(['MECHANIC', 'ADMIN'], weights)).toBe('ADMIN');
    expect(widestRole(['C_NIGHT_LEAD', 'MECHANIC'], weights)).toBe(
      'C_NIGHT_LEAD',
    );
  });

  it('breaks a tie with the built in role, then by code', () => {
    expect(widestRole(['C_NIGHT_LEAD', 'CHIEF_MECHANIC'], weights)).toBe(
      'CHIEF_MECHANIC',
    );
    expect(widestRole(['C_TIRES', 'C_B'], new Map())).toBe('C_B');
  });

  it('answers null for no roles', () => {
    expect(widestRole([], weights)).toBeNull();
  });
});
