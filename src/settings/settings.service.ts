import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import {
  MODULES,
  ModuleName,
  moduleKey,
  SETTINGS_CATALOG,
  SettingKey,
  SettingValue,
  SettingValueOf,
} from './catalog';
import { effectiveValue } from './settings-rules';

/**
 * The one place code reads a setting (spec 0012, AC-3). It holds the effective values and their
 * version; PermissionsService.ensureFresh decides when to reload, since it reads both versions in
 * one query on every checked request (AC-4). Depends on nothing but PrismaService.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private values: Map<string, SettingValue> | null = null;
  private version: number | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** True once settings have loaded; readiness covers them as well as the matrix (AC-4). */
  get isReady() {
    return this.values !== null;
  }

  get currentVersion() {
    return this.version;
  }

  /** Synchronous: reads the cache the guard keeps fresh. Before the first load, the default. */
  get<K extends SettingKey>(key: K): SettingValueOf<K> {
    const value =
      this.values?.get(key) ??
      SETTINGS_CATALOG.find((entry) => entry.key === key)!.default;
    return value as SettingValueOf<K>;
  }

  isModuleOn(name: ModuleName): boolean {
    return this.get(moduleKey(name));
  }

  modules(): Record<ModuleName, boolean> {
    return Object.fromEntries(
      MODULES.map((name) => [name, this.isModuleOn(name)]),
    ) as Record<ModuleName, boolean>;
  }

  /** Runs one load at a time; concurrent requests wait for the same one. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        await this.reload();
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  // The version is read before the rows, as the matrix does: a save landing in between leaves
  // newer values under an older version, which the next request's check reloads
  private async reload() {
    const state = await this.prisma.settingsState.findUnique({
      where: { id: 1 },
      select: { version: true },
    });
    if (!state) throw new Error('settings_state row is missing');
    const rows = await this.prisma.appSetting.findMany({
      select: { key: true, value: true },
    });
    const stored = new Map(rows.map((r) => [r.key, r.value as unknown]));

    const values = new Map<string, SettingValue>();
    for (const entry of SETTINGS_CATALOG) {
      const { value, valid } = effectiveValue(entry, stored.get(entry.key));
      // Logged once per key per version, since a reload runs once per version
      if (!valid) {
        this.logger.warn(
          `Stored value for ${entry.key} breaks its catalog rules; using the default`,
        );
      }
      values.set(entry.key, value);
    }

    this.values = values;
    this.version = state.version;
  }
}
