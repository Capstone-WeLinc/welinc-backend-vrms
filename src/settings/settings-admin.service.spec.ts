import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import type { AuthUser } from '../auth/account-check';
import type { PrismaService } from '../shared/prisma.service';
import { SettingsAdminService, STALE_SETTINGS } from './settings-admin.service';
import type { UpdateSettingsDto } from './dto/update-settings.dto';

// Spec 0012, AC-5 to AC-8: the save, under the version lock, all or nothing

const actor = {
  sub: '00000000-0000-4000-8000-000000000002',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  system: 'VRMS',
  roles: [{ role: 'ADMIN', system: 'VRMS' }],
} as unknown as AuthUser;

type Stored = { key: string; value: unknown };

function setup(version = 8, stored: Stored[] = []) {
  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValue(version === null ? [] : [{ version }]),
    appSetting: {
      findMany: jest.fn().mockResolvedValue(stored),
      delete: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
    },
    settingChange: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    settingsState: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((run: (t: typeof tx) => unknown) => run(tx)),
    // view(), read after the transaction
    settingsState: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ version: version + 1 }),
    },
    appSetting: { findMany: jest.fn().mockResolvedValue([]) },
    settingChange: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new SettingsAdminService(prisma as unknown as PrismaService);
  return { service, tx, prisma };
}

const dto = (over: Partial<UpdateSettingsDto> = {}): UpdateSettingsDto => ({
  version: 8,
  changes: [{ key: 'knowledge.min_samples', value: 4 }],
  ...over,
});

describe('SettingsAdminService.update', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('writes the row, logs one change from the token and bumps the version by one (AC-5)', async () => {
    const { service, tx } = setup();

    await service.update(dto(), actor);

    expect(tx.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'knowledge.min_samples' },
      create: {
        key: 'knowledge.min_samples',
        value: 4,
        updatedByUserId: actor.sub,
      },
      update: { value: 4, updatedByUserId: actor.sub },
    });
    expect(tx.settingChange.createMany).toHaveBeenCalledTimes(1);
    const [{ data }] = tx.settingChange.createMany.mock.calls[0] as [
      { data: Record<string, unknown>[] },
    ];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      key: 'knowledge.min_samples',
      before: 3,
      after: 4,
      action: 'SET',
      actorUserId: actor.sub,
      actorName: 'Victor Ramos',
      actorEmail: 'vrms.admin@welinc.com',
    });
    expect(tx.settingsState.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { version: { increment: 1 } },
    });
  });

  it('answers the new view with the bumped version', async () => {
    const { service } = setup();

    const view = await service.update(dto(), actor);

    expect(view.version).toBe(9);
    expect(view.settings).toHaveLength(17);
  });

  it('deletes the row and logs a RESET when a value goes back to its default (AC-5)', async () => {
    const { service, tx } = setup(8, [
      { key: 'knowledge.min_samples', value: 6 },
    ]);

    await service.update(
      dto({ changes: [{ key: 'knowledge.min_samples', reset: true }] }),
      actor,
    );

    expect(tx.appSetting.delete).toHaveBeenCalledWith({
      where: { key: 'knowledge.min_samples' },
    });
    expect(tx.appSetting.upsert).not.toHaveBeenCalled();
    const [{ data }] = tx.settingChange.createMany.mock.calls[0] as [
      { data: Record<string, unknown>[] },
    ];
    expect(data[0]).toMatchObject({ before: 6, after: 3, action: 'RESET' });
  });

  it('writes nothing and bumps nothing when every change equals the current value (AC-5)', async () => {
    const { service, tx } = setup(8, [
      { key: 'knowledge.min_samples', value: 4 },
    ]);

    const view = await service.update(dto(), actor);

    expect(tx.appSetting.upsert).not.toHaveBeenCalled();
    expect(tx.settingChange.createMany).not.toHaveBeenCalled();
    expect(tx.settingsState.update).not.toHaveBeenCalled();
    expect(view.settings).toHaveLength(17);
  });

  it('refuses a stale version with 409 and the current version, before it reads any rows (AC-7)', async () => {
    const { service, tx } = setup(9);

    const error = await service
      .update(dto({ version: 8 }), actor)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      message: STALE_SETTINGS,
      version: 9,
    });
    expect(tx.appSetting.findMany).not.toHaveBeenCalled();
    expect(tx.appSetting.upsert).not.toHaveBeenCalled();
    expect(tx.settingsState.update).not.toHaveBeenCalled();
  });

  it('answers 409 with a null version when the settings_state row is missing', async () => {
    const { service } = setup(null as unknown as number);

    const error = await service.update(dto(), actor).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      version: null,
    });
  });

  it('answers 409 before 400, so a stale form with bad data reloads first (AC-7)', async () => {
    const { service } = setup(9);

    const error = await service
      .update(
        dto({
          version: 8,
          changes: [{ key: 'knowledge.min_samples', value: 0 }],
        }),
        actor,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
  });

  it('refuses a broken change with 400 and writes nothing (AC-6)', async () => {
    const { service, tx } = setup();

    await expect(
      service.update(
        dto({
          changes: [
            { key: 'knowledge.min_samples', value: 4 },
            { key: 'knowledge.repeat_threshold', value: 99 },
          ],
        }),
        actor,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(tx.appSetting.upsert).not.toHaveBeenCalled();
    expect(tx.settingChange.createMany).not.toHaveBeenCalled();
    expect(tx.settingsState.update).not.toHaveBeenCalled();
  });

  it('needs a reason to move a module and keeps the note on its log row (AC-8)', async () => {
    const { service, tx } = setup();

    await expect(
      service.update(
        dto({ changes: [{ key: 'module.knowledge', value: false }] }),
        actor,
      ),
    ).rejects.toThrow(BadRequestException);

    await service.update(
      dto({
        changes: [{ key: 'module.knowledge', value: false }],
        note: 'Garage trial ended',
      }),
      actor,
    );

    const [{ data }] = tx.settingChange.createMany.mock.calls[0] as [
      { data: Record<string, unknown>[] },
    ];
    expect(data[0]).toMatchObject({
      key: 'module.knowledge',
      before: true,
      after: false,
      note: 'Garage trial ended',
    });
  });

  it('logs one row per changed key in one save and one version bump', async () => {
    const { service, tx } = setup();

    await service.update(
      dto({
        changes: [
          { key: 'knowledge.min_samples', value: 4 },
          { key: 'knowledge.group_min_size', value: 5 },
        ],
      }),
      actor,
    );

    const [{ data }] = tx.settingChange.createMany.mock.calls[0] as [
      { data: unknown[] },
    ];
    expect(data).toHaveLength(2);
    expect(tx.settingsState.update).toHaveBeenCalledTimes(1);
  });

  it('shortens an overlong token email to fit the log column', async () => {
    const { service, tx } = setup();
    const long = {
      ...actor,
      email: `${'a'.repeat(300)}@welinc.com`,
    } as AuthUser;

    await service.update(dto(), long);

    const [{ data }] = tx.settingChange.createMany.mock.calls[0] as [
      { data: { actorEmail: string }[] },
    ];
    expect(data[0].actorEmail).toHaveLength(255);
  });
});

describe('SettingsAdminService.view', () => {
  it('shows a stored value as not default, and a row that breaks its rules as the default', async () => {
    const { service, prisma } = setup();
    prisma.appSetting.findMany.mockResolvedValue([
      { key: 'knowledge.min_samples', value: 6 },
      { key: 'knowledge.group_min_size', value: 0 },
    ]);

    const { settings } = await service.view();

    const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));
    expect(byKey['knowledge.min_samples']).toMatchObject({
      value: 6,
      isDefault: false,
    });
    expect(byKey['knowledge.group_min_size']).toMatchObject({
      value: 3,
      isDefault: true,
    });
    expect(byKey['module.ai']).toMatchObject({ value: true, isDefault: true });
  });

  it('carries who changed a key last, and null for a key never changed (Value sourcing)', async () => {
    const { service, prisma } = setup();
    const when = new Date('2026-10-30T08:00:00Z');
    prisma.settingChange.findMany.mockResolvedValue([
      {
        key: 'knowledge.min_samples',
        createdAt: when,
        actorName: 'Victor Ramos',
        actorEmail: 'vrms.admin@welinc.com',
      },
    ]);

    const { settings } = await service.view();

    const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));
    expect(byKey['knowledge.min_samples'].updatedAt).toBe(when);
    expect(byKey['knowledge.min_samples'].updatedBy).toEqual({
      name: 'Victor Ramos',
      email: 'vrms.admin@welinc.com',
    });
    expect(byKey['module.ai'].updatedAt).toBeNull();
    expect(byKey['module.ai'].updatedBy).toBeNull();
  });

  it('gives a module its list of what it hides, and a value its range and unit', async () => {
    const { service } = setup();

    const { settings } = await service.view();

    const knowledge = settings.find((s) => s.key === 'module.knowledge')!;
    expect(knowledge.hides.length).toBeGreaterThan(0);
    expect(knowledge.min).toBeNull();
    const samples = settings.find((s) => s.key === 'knowledge.min_samples')!;
    expect(samples).toMatchObject({
      min: 1,
      max: 20,
      unit: 'repairs',
      module: 'knowledge',
    });
  });
});
