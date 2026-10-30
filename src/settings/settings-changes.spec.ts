import 'reflect-metadata';
import type { PrismaService } from '../shared/prisma.service';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListChangesQueryDto, parseKeys } from './dto/list-changes.dto';
import { SETTINGS_CATALOG } from './catalog';
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

describe('SettingsAdminService.changes with keys (AC-31)', () => {
  it('filters on the keys in the same query, after kind and before the limit', async () => {
    const { service, queryRaw } = setup([settingRow(2)]);
    await service.changes(
      {
        kind: 'setting',
        keys: 'module.ai,module.ai,knowledge.min_samples',
        limit: 5,
      },
      true,
    );
    const [strings, ...values] = queryRaw.mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    // The keys filter sits in the WHERE, so before the ORDER BY ... LIMIT text
    const [where] = strings.join('?').split('ORDER BY');
    expect(where).toContain('c.kind IN');
    expect(JSON.stringify(values)).toContain('c.key IN');
    const flat = JSON.stringify(values);
    for (const key of ['module.ai', 'knowledge.min_samples']) {
      expect(flat).toContain(key);
    }
    // duplicates dropped: module.ai appears once
    expect(flat.match(/module\.ai/g)).toHaveLength(1);
    expect(flat).toContain('6'); // limit + 1
  });

  it('pages with keys: a cursor comes back and the filter stays', async () => {
    const { service } = setup([settingRow(3), settingRow(2), settingRow(1)]);
    const res = await service.changes(
      { keys: 'knowledge.min_samples', limit: 2 },
      true,
    );
    expect(res.nextCursor).toEqual(expect.any(String));
  });

  it('asks nothing for permission rows without permissions.manage, whatever keys holds', async () => {
    const { service, queryRaw } = setup([]);
    await service.changes({ kind: 'permission', keys: 'ticket.view' }, false);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('ListChangesQueryDto keys (AC-31)', () => {
  const problems = (keys: unknown) =>
    validateSync(plainToInstance(ListChangesQueryDto, { keys })).flatMap((e) =>
      Object.values(e.constraints ?? {}),
    );
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => `k${i}`).join(',');

  it('accepts one key, several keys and a removed key', () => {
    expect(problems('module.ai')).toEqual([]);
    expect(problems('module.ai,knowledge.min_samples')).toEqual([]);
    expect(problems('gone.key')).toEqual([]);
    expect(problems(many(50))).toEqual([]);
  });

  it('counts distinct keys, so duplicates do not use up the cap', () => {
    expect(problems(`${many(50)},k0`)).toEqual([]);
    expect(parseKeys('a,a,b')).toEqual(['a', 'b']);
  });

  it.each([
    ['empty', ''],
    ['empty piece', 'a,,b'],
    ['trailing comma', 'a,'],
    ['given twice', ['a', 'b']],
    ['51 distinct keys', many(51)],
    ['61 characters', 'a'.repeat(61)],
    ['uppercase', 'Module.AI'],
    ['space', 'a, b'],
  ])('rejects %s with a 400 rule', (_name, keys) => {
    expect(problems(keys)).toHaveLength(1);
  });

  it('keeps each section at 50 keys or fewer (Modules, Thresholds)', () => {
    const count = (kind: string) =>
      SETTINGS_CATALOG.filter((e) => e.kind === kind).length;
    expect(count('module')).toBeLessThanOrEqual(50);
    expect(count('value')).toBeLessThanOrEqual(50);
  });
});
