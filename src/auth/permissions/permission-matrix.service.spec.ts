import type { PrismaService } from '../../shared/prisma.service';
import { MATRIX_ROLES, PERMISSION_CATALOG } from './catalog';
import { PermissionMatrixService } from './permission-matrix.service';

// Spec 0011, AC-17, read only since suite spec 0013 (AC-30): the synced copy as keys and values.

function setup(rows: { role: string; permission: string; allowed: boolean }[]) {
  const prisma = {
    permissionMatrix: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ version: 12 }),
    },
    permissionSyncState: {
      findUnique: jest.fn().mockResolvedValue({
        etag: '"v3"',
        syncedAt: new Date('2026-11-13T10:00:00Z'),
      }),
    },
    rolePermission: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  return new PermissionMatrixService(prisma as unknown as PrismaService);
}

describe('PermissionMatrixService.view (AC-17, suite spec 0013 AC-30)', () => {
  it('lists every catalog key with each role, the version and where the copy came from', async () => {
    const view = await setup([
      { role: 'ADMIN', permission: 'ticket.view', allowed: true },
    ]).view();

    expect(view.version).toBe(12);
    expect(view.source.etag).toBe('"v3"');
    expect(view.roles).toEqual([...MATRIX_ROLES]);
    expect(view.keys.map((k) => k.key)).toEqual(
      PERMISSION_CATALOG.map((e) => e.key),
    );
    expect(view.keys[0].grants).toEqual({
      ADMIN: true,
      CHIEF_MECHANIC: false,
      MECHANIC: false,
    });
  });

  it('shows a missing row as not allowed and tags module keys', async () => {
    const view = await setup([]).view();
    const ai = view.keys.find((k) => k.key === 'ai.use');
    expect(ai?.module).toBe('ai');
    expect(Object.values(ai?.grants ?? {})).toEqual([false, false, false]);
  });
});
