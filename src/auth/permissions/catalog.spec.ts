import {
  catalogEntry,
  MATRIX_ROLES,
  PERMISSION_CATALOG,
  ROLE_LABELS,
} from './catalog';

// The table of spec 0011, "Permission catalog", plus spec 0012's three keys (AC-18):
// A = Admin, C = Chief Mechanic, M = Mechanic.
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
  ['ai.use', 'Tickets', true, true, true],
  ['audit.view', 'Records', true, false, false],
  ['analytics.view', 'Records', true, false, false],
  ['config.read', 'Records', true, true, true],
  ['knowledge.view', 'Knowledge', true, true, true],
  ['knowledge.suggest', 'Knowledge', true, true, true],
  ['knowledge.edit', 'Knowledge', true, true, false],
  ['users.manage', 'Admin', true, false, false],
  ['permissions.manage', 'Admin', true, false, false],
  ['settings.manage', 'Admin', true, false, false],
  ['lookups.manage', 'Admin', true, true, false],
];

const LOCKED_KEYS = ['users.manage', 'permissions.manage'];

// Spec 0012, AC-10: the keys a module switch removes
const MODULE_KEYS = {
  'ai.use': 'ai',
  'analytics.view': 'analytics',
  'knowledge.view': 'knowledge',
  'knowledge.suggest': 'knowledge',
  'knowledge.edit': 'knowledge',
};

describe('permission catalog', () => {
  // covers: AC-1
  it('holds exactly the 19 keys of the specs, in the spec order', () => {
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
  it('seeds one row per matrix role and key, 57 today', () => {
    expect(MATRIX_ROLES).toEqual(['ADMIN', 'CHIEF_MECHANIC', 'MECHANIC']);
    expect(MATRIX_ROLES.length * PERMISSION_CATALOG.length).toBe(57);
  });

  // covers: AC-4
  it('locks users.manage and permissions.manage for every role, and settings.manage for Admin only', () => {
    const locked = PERMISSION_CATALOG.filter((e) => 'locked' in e).map(
      (e) => e.key,
    );

    expect(locked).toEqual([...LOCKED_KEYS, 'settings.manage']);
    expect(catalogEntry('settings.manage')?.locked).toEqual({ ADMIN: true });
    for (const key of LOCKED_KEYS) {
      expect(catalogEntry(key)?.locked).toEqual({
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
      'ai.use',
      'config.read',
      'knowledge.view',
      'knowledge.suggest',
      'knowledge.edit',
      'lookups.manage',
    ]);
    expect(allowed('MECHANIC')).toEqual([
      'ticket.view',
      'ticket.work',
      'ai.use',
      'config.read',
      'knowledge.view',
      'knowledge.suggest',
    ]);
    expect(allowed('ADMIN')).toHaveLength(18);
    expect(allowed('ADMIN')).not.toContain('ticket.work');
  });

  // Spec 0012, AC-10
  it('tags exactly the module keys with their module', () => {
    const tagged = Object.fromEntries(
      PERMISSION_CATALOG.flatMap((e) => {
        const module = catalogEntry(e.key)?.module;
        return module ? [[e.key, module]] : [];
      }),
    );
    expect(tagged).toEqual(MODULE_KEYS);
  });
});
