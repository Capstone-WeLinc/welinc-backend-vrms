import type { PrismaService } from '../shared/prisma.service';
import { SettingsAdminService } from './settings-admin.service';

// Spec 0012, AC-26: the merged history

const at = (n: number) => new Date(`2026-10-30T00:00:0${n}Z`);
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function setup(rows: unknown[]) {
  const queryRaw = jest.fn().mockResolvedValue(rows);
  const service = new SettingsAdminService({
    $queryRaw: queryRaw,
  } as unknown as PrismaService);
  return { service, queryRaw };
}

const settingRow = (n: number) => ({
  kind: 'setting',
  id: ID(n),
  key: 'knowledge.min_samples',
  role: null,
  before: 3,
  after: 4,
  action: 'SET',
  actor_name: 'Ana',
  actor_email: 'ana@welinc.com',
  note: null,
  created_at: at(n),
});

describe('SettingsAdminService.changes', () => {
  it('labels rows from the catalogs and shows a null actor as null', async () => {
    const { service } = setup([
      settingRow(2),
      {
        kind: 'permission',
        id: ID(1),
        key: 'knowledge.edit',
        role: 'MECHANIC',
        before: null,
        after: true,
        action: null,
        actor_name: null,
        actor_email: null,
        note: null,
        created_at: at(1),
      },
      { ...settingRow(0), key: 'gone.key' },
    ]);
    const res = await service.changes({}, true);
    expect(res.data[0]).toMatchObject({
      label: 'Repairs before typical time and cost',
      actor: { name: 'Ana', email: 'ana@welinc.com' },
    });
    expect(res.data[1]).toMatchObject({
      kind: 'permission',
      roleLabel: 'Mechanic',
      actor: null,
    });
    expect(res.data[2].label).toBe('gone.key');
    expect(res.nextCursor).toBeNull();
  });

  it('returns a cursor when there is another page', async () => {
    const { service } = setup([settingRow(3), settingRow(2), settingRow(1)]);
    const res = await service.changes({ limit: 2 }, true);
    expect(res.data).toHaveLength(2);
    expect(res.nextCursor).toEqual(expect.any(String));
  });

  it('hides permission rows from a caller without permissions.manage, without a query', async () => {
    const { service, queryRaw } = setup([]);
    expect(await service.changes({ kind: 'permission' }, false)).toEqual({
      data: [],
      nextCursor: null,
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
