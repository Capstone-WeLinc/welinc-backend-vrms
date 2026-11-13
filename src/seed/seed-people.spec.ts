import { describe, expect, it, jest } from '@jest/globals';
import type { PrismaClient } from '@prisma/client';
import { seedMechanics } from '../../prisma/seeds/mechanics.seed';
import {
  MANIFEST_PEOPLE,
  seedActor,
  vrmsRole,
} from '../../prisma/seeds/shared-ids';

// Spec 0006: the VRMS side of the suite seed accounts. It reads the people.json copy and links
// its own rows to the shared fixed ids.

describe('people.json copy', () => {
  it('holds the 147 people (145, the suite admin from suite spec 0013, vmms.mech@ from suite spec 0014) with unique ids and emails', () => {
    // covers: AC-1, AC-14
    expect(MANIFEST_PEOPLE).toHaveLength(147);
    expect(new Set(MANIFEST_PEOPLE.map((p) => p.id)).size).toBe(147);
    expect(new Set(MANIFEST_PEOPLE.map((p) => p.email)).size).toBe(147);
  });

  it('no longer holds the old ops.user and cs.user logins', () => {
    // covers: AC-3, AC-14
    const emails = MANIFEST_PEOPLE.map((p) => p.email);
    expect(emails).not.toContain('ops.user@welinc.com');
    expect(emails).not.toContain('cs.user@welinc.com');
    expect(emails).toContain('bms.ops@welinc.com');
    expect(emails).toContain('bms.cs@welinc.com');
  });
});

describe('vrmsRole', () => {
  it('returns the VRMS role code, ignoring other systems', () => {
    expect(
      vrmsRole({
        roles: [
          { system: 'VMMS', role: 'OPERATIONS' },
          { system: 'VRMS', role: 'CHIEF_MECHANIC' },
        ],
      }),
    ).toBe('CHIEF_MECHANIC');
  });

  it('is null for a person with no VRMS role', () => {
    expect(vrmsRole({ roles: [{ system: 'BMS', role: 'DRIVER' }] })).toBeNull();
    expect(vrmsRole({ roles: [] })).toBeNull();
  });
});

describe('seedActor', () => {
  it('gives the chief the CHIEF_MECHANIC role and the shared id', () => {
    // covers: AC-14
    expect(seedActor('vrms.chief@welinc.com')).toEqual({
      actorUserId: '00000000-0000-4000-8000-000000001201',
      actorName: 'Ramon Villanueva',
      actorEmail: 'vrms.chief@welinc.com',
      actorRole: 'CHIEF_MECHANIC',
    });
  });

  it('gives an unknown email a null id and role, keeping the email as the name', () => {
    // covers: AC-14
    expect(seedActor('nobody@welinc.com')).toEqual({
      actorUserId: null,
      actorName: 'nobody@welinc.com',
      actorEmail: 'nobody@welinc.com',
      actorRole: null,
    });
  });
});

describe('seedMechanics', () => {
  type Row = {
    authUserId: string;
    email: string;
    name: string;
    role: string | null;
    isActive: boolean;
  };

  async function run(): Promise<Row[]> {
    const createMany = jest.fn((args: { data: Row[] }) =>
      Promise.resolve({ count: args.data.length }),
    );
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await seedMechanics({
      mechanic: { createMany },
    } as unknown as PrismaClient);
    log.mockRestore();
    return createMany.mock.calls[0][0].data;
  }

  it('makes 77 rows: 69 mechanics and 8 chiefs, only for VRMS mechanic roles', async () => {
    // covers: AC-15
    const rows = await run();
    expect(rows).toHaveLength(77);
    expect(rows.filter((r) => r.role === 'CHIEF_MECHANIC')).toHaveLength(8);
    expect(rows.filter((r) => r.role === 'MECHANIC')).toHaveLength(69);
    expect(rows.every((r) => r.role !== null)).toBe(true);
    expect(
      rows.find((r) => r.email === 'vrms.admin@welinc.com'),
    ).toBeUndefined();
  });

  it('links each row to the shared id and lowercases the email', async () => {
    // covers: AC-15
    const rows = await run();
    const ids = new Set(MANIFEST_PEOPLE.map((p) => p.id));
    for (const row of rows) {
      expect(ids.has(row.authUserId)).toBe(true);
      expect(row.email).toBe(row.email.toLowerCase());
    }
  });

  it('marks only the deactivated and deleted people inactive', async () => {
    // covers: AC-15
    const inactive = (await run()).filter((r) => !r.isActive);
    expect(inactive.map((r) => r.email).sort()).toEqual([
      'state.deactivated@welinc.com',
      'state.deleted@welinc.com',
    ]);
  });

  it('gives a multi system person their VRMS role, not their other roles', async () => {
    // covers: AC-15
    const rows = await run();
    expect(rows.find((r) => r.email === 'multi.mixed@welinc.com')?.role).toBe(
      'CHIEF_MECHANIC',
    );
    expect(rows.find((r) => r.email === 'mech.juan@welinc.com')?.role).toBe(
      'MECHANIC',
    );
  });
});
