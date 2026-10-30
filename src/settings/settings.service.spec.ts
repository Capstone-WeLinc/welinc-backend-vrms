import { Logger } from '@nestjs/common';
import type { PrismaService } from '../shared/prisma.service';
import { SettingsService } from './settings.service';

// Spec 0012, AC-3 and AC-4: the one place code reads a setting, and its cache

type Row = { key: string; value: unknown };

function setup(rows: Row[] = [], version: number | null = 5) {
  const findUnique = jest
    .fn()
    .mockResolvedValue(version === null ? null : { version });
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = {
    settingsState: { findUnique },
    appSetting: { findMany },
  } as unknown as PrismaService;
  return { service: new SettingsService(prisma), findUnique, findMany };
}

describe('SettingsService', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('answers the catalog default and reports not ready before the first load (AC-4)', () => {
    const { service } = setup();

    expect(service.isReady).toBe(false);
    expect(service.currentVersion).toBeNull();
    expect(service.get('knowledge.min_samples')).toBe(3);
    expect(service.isModuleOn('ai')).toBe(true);
  });

  it('serves the stored value and the version after a load (AC-3)', async () => {
    const { service } = setup(
      [
        { key: 'knowledge.min_samples', value: 7 },
        { key: 'module.analytics', value: false },
      ],
      9,
    );

    await service.load();

    expect(service.isReady).toBe(true);
    expect(service.currentVersion).toBe(9);
    expect(service.get('knowledge.min_samples')).toBe(7);
    expect(service.modules()).toEqual({
      ai: true,
      analytics: false,
      knowledge: true,
    });
  });

  it('takes the default for a key with no row (AC-2)', async () => {
    const { service } = setup([{ key: 'knowledge.min_samples', value: 7 }]);

    await service.load();

    expect(service.get('knowledge.repeat_window_days')).toBe(365);
  });

  it('ignores a row whose key left the catalog', async () => {
    const { service } = setup([{ key: 'knowledge.gone', value: 99 }]);

    await service.load();

    expect(service.isReady).toBe(true);
    expect(service.modules()).toEqual({
      ai: true,
      analytics: true,
      knowledge: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses the default and warns once for a stored value that breaks its rules (AC-3)', async () => {
    const { service } = setup([{ key: 'knowledge.min_samples', value: 0 }]);

    await service.load();

    expect(service.get('knowledge.min_samples')).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('knowledge.min_samples'),
    );
  });

  it('reads a switch stored as a wrong type as the default, so a module is never half off', async () => {
    const { service } = setup([{ key: 'module.ai', value: 'false' }]);

    await service.load();

    expect(service.isModuleOn('ai')).toBe(true);
  });

  it('runs one load for concurrent callers', async () => {
    const { service, findUnique } = setup();

    await Promise.all([service.load(), service.load(), service.load()]);

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('can load again after a load finished, picking up new values (AC-4)', async () => {
    const { service, findMany } = setup(
      [{ key: 'knowledge.min_samples', value: 4 }],
      1,
    );
    await service.load();
    findMany.mockResolvedValue([{ key: 'knowledge.min_samples', value: 6 }]);

    await service.load();

    expect(service.get('knowledge.min_samples')).toBe(6);
  });

  it('rejects when the settings_state row is missing and stays not ready', async () => {
    const { service } = setup([], null);

    await expect(service.load()).rejects.toThrow(
      'settings_state row is missing',
    );
    expect(service.isReady).toBe(false);
  });

  it('keeps the last values when a later load fails (AC-4)', async () => {
    const { service, findMany } = setup([
      { key: 'knowledge.min_samples', value: 8 },
    ]);
    await service.load();
    findMany.mockRejectedValue(new Error('db down'));

    await expect(service.load()).rejects.toThrow('db down');

    expect(service.get('knowledge.min_samples')).toBe(8);
    expect(service.isReady).toBe(true);
  });

  it('lets a failed load be tried again instead of sticking on the failure', async () => {
    const { service, findMany } = setup([
      { key: 'knowledge.min_samples', value: 8 },
    ]);
    findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(service.load()).rejects.toThrow('db down');

    await service.load();

    expect(service.get('knowledge.min_samples')).toBe(8);
  });
});
