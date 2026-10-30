import type { ModuleName, SettingKey, SettingValueOf } from './catalog';
import { SettingsService } from './settings.service';
import type { PrismaService } from '../shared/prisma.service';

/**
 * Stands in for SettingsService in unit tests: the catalog defaults (every module on), with
 * values or switches overridden per test.
 */
export class FakeSettings extends SettingsService {
  private readonly overrides = new Map<string, number | boolean>();

  constructor(overrides: Partial<Record<SettingKey, number | boolean>> = {}) {
    super(null as unknown as PrismaService);
    for (const [key, value] of Object.entries(overrides)) {
      this.overrides.set(key, value);
    }
  }

  override get isReady() {
    return true;
  }

  override get currentVersion() {
    return 1;
  }

  override get<K extends SettingKey>(key: K): SettingValueOf<K> {
    return (this.overrides.get(key) ?? super.get(key)) as SettingValueOf<K>;
  }

  override load() {
    return Promise.resolve();
  }

  set(key: SettingKey, value: number | boolean) {
    this.overrides.set(key, value);
  }

  turnOff(module: ModuleName) {
    this.overrides.set(`module.${module}`, false);
  }
}
