import { MATRIX_ROLES, PERMISSION_CATALOG, ROLE_LABELS } from './catalog';

// The table of spec 0011, "Permission catalog": A = Admin, C = Chief Mechanic, M = Mechanic.
// Written out here on purpose, so a changed default or lock fails this test and gets noticed.
const EXPECTED: Array<
  [key: string, group: string, A: boolean, C: boolean, M: boolean]
> = [
  ['ticket.view', 'Tickets', true, true, true],
  ['ticket.view_all', 'Tickets', true, true, false],
  ['ticket.create', 'Tickets', true, false, false],
  ['ticket.work', 'Tickets', false, true, true],
  ['ticket.administer', 'Tickets', true, false, false],
  ['ticket.costs.view', 'Tickets', true, false, false],
  ['ticket.costs.edit', 'Tickets', true, false, false],
  ['ticket.unlock', 'Tickets', true, false, false],
  ['audit.view', 'Records', true, false, false],
  ['analytics.view', 'Records', true, false, false],
  ['config.read', 'Records', true, true, true],
  ['knowledge.view', 'Knowledge', true, true, true],
  ['knowledge.suggest', 'Knowledge', true, true, true],
  ['knowledge.edit', 'Knowledge', true, true, false],
  ['users.manage', 'Admin', true, false, false],
  ['permissions.manage', 'Admin', true, false, false],
];

const LOCKED_KEYS = ['users.manage', 'permissions.manage'];

describe('permission catalog', () => {
  // covers: AC-1
  it('holds exactly the 16 keys of the spec, in the spec order', () => {
    expect(PERMISSION_CATALOG.map((e) => e.key)).toEqual(
      EXPECTED.map(([key]) => key),
    );
  });

  // covers: AC-1
  it.each(EXPECTED)(
    '%s keeps its group and its defaults',
    (key, group, a, c, m) => {
      const entry = PERMISSION_CATALOG.find((e) => e.key === key);

      expect(entry?.group).toBe(group);
      expect(entry?.defaults).toEqual({
        ADMIN: a,
        CHIEF_MECHANIC: c,
        MECHANIC: m,
      });
    },
  );

  // covers: AC-1
  it('has no duplicate keys', () => {
    const keys = PERMISSION_CATALOG.map((e) => e.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  // covers: AC-1
  it('gives every key a label and a description for the settings table', () => {
    for (const entry of PERMISSION_CATALOG) {
      expect(entry.label.trim()).not.toBe('');
      expect(entry.description.trim()).not.toBe('');
    }
  });

  // covers: AC-1, AC-2
  it('seeds one row per matrix role and key, 48 today', () => {
    expect(MATRIX_ROLES).toEqual(['ADMIN', 'CHIEF_MECHANIC', 'MECHANIC']);
    expect(MATRIX_ROLES.length * PERMISSION_CATALOG.length).toBe(48);
  });

  // covers: AC-4
  it('locks users.manage and permissions.manage for every role, and nothing else', () => {
    const locked = PERMISSION_CATALOG.filter((e) => e.locked).map((e) => e.key);

    expect(locked).toEqual(LOCKED_KEYS);
    for (const key of LOCKED_KEYS) {
      const entry = PERMISSION_CATALOG.find((e) => e.key === key);
      expect(entry?.locked).toEqual({
        ADMIN: true,
        CHIEF_MECHANIC: true,
        MECHANIC: true,
      });
    }
  });

  // covers: AC-4
  it('locks Admin on and the other roles off, so Admin can never lose the two rights', () => {
    for (const key of LOCKED_KEYS) {
      const entry = PERMISSION_CATALOG.find((e) => e.key === key);
      expect(entry?.defaults).toEqual({
        ADMIN: true,
        CHIEF_MECHANIC: false,
        MECHANIC: false,
      });
    }
  });

  it('labels every matrix role for the settings table', () => {
    expect(ROLE_LABELS).toEqual({
      ADMIN: 'Admin',
      CHIEF_MECHANIC: 'Chief Mechanic',
      MECHANIC: 'Mechanic',
    });
  });

  // covers: AC-14
  it('keeps the old behavior for every role, with Chief seeing every ticket as the one change', () => {
    const allowed = (role: 'ADMIN' | 'CHIEF_MECHANIC' | 'MECHANIC') =>
      PERMISSION_CATALOG.filter((e) => e.defaults[role]).map((e) => e.key);

    expect(allowed('CHIEF_MECHANIC')).toEqual([
      'ticket.view',
      'ticket.view_all',
      'ticket.work',
      'config.read',
      'knowledge.view',
      'knowledge.suggest',
      'knowledge.edit',
    ]);
    expect(allowed('MECHANIC')).toEqual([
      'ticket.view',
      'ticket.work',
      'config.read',
      'knowledge.view',
      'knowledge.suggest',
    ]);
    expect(allowed('ADMIN')).toHaveLength(15);
    expect(allowed('ADMIN')).not.toContain('ticket.work');
  });
});
