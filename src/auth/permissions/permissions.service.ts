import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../shared/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import type { AuthUser } from '../account-check';
import { AppAbility, buildAbility } from './ability.factory';
import { catalogEntry, PERMISSION_CATALOG, PermissionKey } from './catalog';
import { PermissionSync } from './sync/permission-sync.service';
import { setRoleWeights } from './widest-role';

// Spec 0011, read side. Since suite spec 0013 (AC-29, AC-30) role_permissions is written only by
// the matrix sync from welinc-auth (sync/permission-sync.service.ts), which also enforces locks;
// there is no startup backfill any more.

export const MATRIX_UNAVAILABLE =
  'Permissions are not loaded yet. Try again in a moment.';

/** Suite spec 0018 child 0002, AC-32: every role code the synced rows name, custom ones included. */
type Grants = Map<string, ReadonlySet<PermissionKey>>;

/** At most one sync for an unknown role code per this many ms, across the process (AC-32). */
export const UNKNOWN_ROLE_SYNC_MS = 10_000;

/** What a reload hands its listeners: the new grants, and the keys that have rows at all. */
export type LoadedGrants = {
  version: number;
  grants: ReadonlyMap<string, ReadonlySet<PermissionKey>>;
  /** Keys welinc-auth sent (they have rows); a key outside it was never synced. */
  syncedKeys: ReadonlySet<string>;
};

@Injectable()
export class PermissionsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionsService.name);
  private grants: Grants | null = null;
  private version: number | null = null;
  // Granted keys per sorted role set; emptied on every matrix or settings reload (AC-9, spec 0012)
  private readonly keyCache = new Map<string, ReadonlySet<PermissionKey>>();
  private loading: Promise<void> | null = null;
  private syncedKeys: ReadonlySet<string> = new Set();
  private readonly listeners: ((loaded: LoadedGrants) => void)[] = [];
  private lastUnknownSync = 0;
  private unknownSync: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly sync: PermissionSync,
  ) {
    this.sync.whenApplied(() => {
      this.load().catch((err: unknown) =>
        this.logger.warn(`Reload after a matrix sync failed: ${reason(err)}`),
      );
    });
  }

  /**
   * Called after every reload of the grants in this process (the first one included). The mechanic
   * roster listens, so it recomputes only from loaded grants (child 0002, AC-33).
   */
  whenLoaded(listener: (loaded: LoadedGrants) => void): void {
    this.listeners.push(listener);
  }

  /** True when welinc-auth's matrix carried `key` in the last load (it has rows). */
  hasSynced(key: string): boolean {
    return this.syncedKeys.has(key);
  }

  /**
   * Child 0002, AC-32: a role code the last load doesn't know (a custom role made a moment ago)
   * runs one sync at once, at most once per 10 s across the process, then reloads. A code still
   * unknown afterwards gets no keys. Never throws: the last copy stays.
   */
  async ensureKnown(roles: readonly string[]): Promise<void> {
    if (!this.grants) return;
    if (roles.every((role) => this.grants?.has(role))) return;
    if (this.unknownSync) return this.unknownSync;
    if (Date.now() - this.lastUnknownSync < UNKNOWN_ROLE_SYNC_MS) return;
    this.lastUnknownSync = Date.now();
    this.unknownSync = (async () => {
      try {
        await this.sync.tick();
        await this.load();
      } catch (err) {
        this.logger.warn(
          `Sync for an unknown role code failed, keeping matrix ${this.version}: ${reason(err)}`,
        );
      } finally {
        this.unknownSync = null;
      }
    })();
    return this.unknownSync;
  }

  async onApplicationBootstrap() {
    try {
      await this.loadCold();
    } catch (err) {
      // A cold replica answers 503 and fails readiness until a later request loads it (AC-21)
      this.logger.warn(
        `Permission matrix or settings not loaded at startup: ${reason(err)}`,
      );
    }
  }

  /** True once the matrix and settings have loaded; the readiness probe reads it (AC-21). */
  get isReady() {
    return this.grants !== null && this.settings.isReady;
  }

  get currentVersion() {
    return this.version;
  }

  /**
   * One query per checked request reads the matrix and settings versions; whichever moved
   * reloads first (AC-20, spec 0012 AC-4). When the read or reload fails, a warm replica keeps
   * what it has; a cold one answers 503.
   */
  async ensureFresh(): Promise<void> {
    try {
      if (!this.isReady) {
        await this.loadCold();
        return;
      }
      const versions = await this.readVersions();
      if (versions.matrix !== this.version) await this.load();
      if (versions.settings !== this.settings.currentVersion) {
        await this.settings.load();
        this.keyCache.clear();
      }
    } catch (err) {
      if (!this.isReady) {
        this.logger.warn(`Permission matrix unavailable: ${reason(err)}`);
        throw new ServiceUnavailableException(MATRIX_UNAVAILABLE);
      }
      this.logger.warn(
        `Permission matrix or settings check failed, keeping matrix ${this.version} and settings ${this.settings.currentVersion}: ${reason(err)}`,
      );
    }
  }

  /**
   * The union of the grants of every synced role held; a role the matrix doesn't name grants
   * nothing (AC-5, child 0002 AC-32). A key whose module is off is left out, whatever the matrix
   * says (spec 0012, AC-10).
   */
  keysFor(roles: readonly string[]): ReadonlySet<PermissionKey> {
    const held = [...new Set(roles.filter((r) => this.grants?.has(r)))].sort();
    const cacheKey = held.join(',');
    const cached = this.keyCache.get(cacheKey);
    if (cached) return cached;

    const keys = new Set<PermissionKey>();
    for (const role of held) {
      for (const key of this.grants?.get(role) ?? []) {
        const owner = catalogEntry(key)?.module;
        if (owner && !this.settings.isModuleOn(owner)) continue;
        keys.add(key);
      }
    }
    this.keyCache.set(cacheKey, keys);
    return keys;
  }

  /** Built per request and never cached, because its conditions carry the caller's id (AC-9). */
  abilityFor(user: Pick<AuthUser, 'sub' | 'roles'>): AppAbility {
    return buildAbility(user.sub, this.keysFor(user.roles.map((r) => r.role)));
  }

  /** The first load: the matrix, and the settings. */
  private async loadCold() {
    if (!this.grants) await this.load();
    if (!this.settings.isReady) {
      await this.settings.load();
      this.keyCache.clear();
    }
  }

  /** Runs one load at a time; concurrent requests wait for the same one. */
  private load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        await this.reload();
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  // Spec 0012, Implementation contract: both versions in one round trip
  private async readVersions(): Promise<{ matrix: number; settings: number }> {
    const [row] = await this.prisma.$queryRaw<
      { matrix: number | null; settings: number | null }[]
    >`
      SELECT (SELECT version FROM permission_matrix WHERE id = 1) AS matrix,
             (SELECT version FROM settings_state WHERE id = 1) AS settings
    `;
    if (row?.matrix == null)
      throw new Error('permission_matrix row is missing');
    if (row.settings == null) throw new Error('settings_state row is missing');
    return { matrix: row.matrix, settings: row.settings };
  }

  private async readVersion(): Promise<number> {
    const row = await this.prisma.permissionMatrix.findUnique({
      where: { id: 1 },
      select: { version: true },
    });
    if (!row) throw new Error('permission_matrix row is missing');
    return row.version;
  }

  // The version is read before the rows: a change landing in between leaves a newer row set
  // under an older version, which the next request's check reloads, never the other way round
  private async reload() {
    const version = await this.readVersion();
    const rows = await this.prisma.rolePermission.findMany({
      select: { role: true, permission: true, allowed: true },
    });
    const stored = new Map(
      rows.map((r) => [`${r.role}|${r.permission}`, r.allowed]),
    );

    // Child 0002, AC-32: the roles are whatever the synced rows name
    const roles = [...new Set(rows.map((r) => r.role))].sort();
    const grants: Grants = new Map();
    for (const role of roles) {
      const keys = new Set<PermissionKey>();
      for (const entry of PERMISSION_CATALOG) {
        // A missing row denies (AC-6); locks are kept by welinc-auth, so the row is the value
        if (stored.get(`${role}|${entry.key}`) === true) keys.add(entry.key);
      }
      grants.set(role, keys);
    }
    const syncedKeys = new Set(rows.map((r) => r.permission));

    this.grants = grants;
    this.version = version;
    this.syncedKeys = syncedKeys;
    this.keyCache.clear();
    setRoleWeights(
      new Map([...grants].map(([role, keys]) => [role, keys.size])),
    );
    for (const listener of this.listeners) {
      try {
        listener({ version, grants, syncedKeys });
      } catch (err) {
        this.logger.warn(`A grants listener failed: ${reason(err)}`);
      }
    }
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
