import { catalogEntry, PERMISSION_CATALOG } from './catalog';
import { defaultKeys } from './permissions.fake';

// Spec 0011, AC-1, and suite spec 0013, AC-25, AC-30: the keys VRMS checks. Their labels, defaults
// and locks moved to welinc-auth's prisma/catalog/vrms.ts; this list must match its keys (minus
// none, plus none), so a key added on one side and not the other is noticed. Written out on
// purpose, in welinc-auth's order.
const KEYS = [
  'ticket.view',
  'ticket.view_all',
  'ticket.create',
  'ticket.work',
  'ticket.administer',
  'ticket.verify',
  'ticket.costs.view',
  'ticket.costs.edit',
  'ticket.assign',
  'ticket.edit',
  'ticket.unlock',
  'ticket.checklist.edit',
  'ticket.files.add',
  'ticket.documents.add',
  'ticket.files.remove_any',
  'ai.use',
  'integration.respond',
  'audit.view',
  'analytics.view',
  'config.read',
  'mechanics.view',
  'vehicle.manage',
  'knowledge.view',
  'knowledge.suggest',
  'knowledge.edit',
  'team.manage',
  'settings.manage',
  'lookups.manage',
];

// Spec 0012, AC-10: the keys a module switch removes
const MODULE_KEYS = {
  'ai.use': 'ai',
  'analytics.view': 'analytics',
  'knowledge.view': 'knowledge',
  'knowledge.suggest': 'knowledge',
  'knowledge.edit': 'knowledge',
};

describe('permission catalog', () => {
  it('holds exactly the keys welinc-auth syncs, in its order', () => {
    expect(PERMISSION_CATALOG.map((e) => e.key)).toEqual(KEYS);
  });

  it('has no duplicate keys', () => {
    const keys = PERMISSION_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('no longer holds the keys that left with account and matrix editing (suite spec 0013)', () => {
    expect(catalogEntry('users.manage')).toBeUndefined();
    expect(catalogEntry('permissions.manage')).toBeUndefined();
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

describe('the test matrix (a copy of welinc-auth defaults)', () => {
  it('gives each role the rights a fresh suite starts with', () => {
    expect([...defaultKeys(['CHIEF_MECHANIC'])]).toEqual([
      'ticket.view',
      'ticket.view_all',
      'ticket.work',
      'ticket.verify',
      'ticket.costs.view',
      'ticket.assign',
      'ticket.checklist.edit',
      'ticket.files.add',
      'ticket.documents.add',
      'ticket.files.remove_any',
      'ai.use',
      'config.read',
      'mechanics.view',
      'knowledge.view',
      'knowledge.suggest',
      'knowledge.edit',
      'lookups.manage',
    ]);
    expect([...defaultKeys(['MECHANIC'])]).toEqual([
      'ticket.view',
      'ticket.work',
      'ticket.checklist.edit',
      'ticket.files.add',
      'ai.use',
      'config.read',
      'knowledge.view',
      'knowledge.suggest',
    ]);
    expect(defaultKeys(['ADMIN']).size).toBe(27);
    expect(defaultKeys(['ADMIN']).has('ticket.work')).toBe(false);
  });

  it('covers every catalog key and nothing else', () => {
    const all = defaultKeys(['ADMIN', 'CHIEF_MECHANIC', 'MECHANIC']);
    expect([...all].sort()).toEqual([...KEYS].sort());
  });
});
