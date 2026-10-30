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
import {
  catalogEntry,
  isLocked,
  isMatrixRole,
  MATRIX_ROLES,
  MatrixRole,
  PERMISSION_CATALOG,
  PermissionKey,
} from './catalog';

// Spec 0011, AC-3 and AC-20: every booting replica takes this lock before the backfill, so two
// never both insert. Any constant works as long as nothing else in this database uses it.
const BACKFILL_LOCK_ID = 110011;

export const MATRIX_UNAVAILABLE =
  'Permissions are not loaded yet. Try again in a moment.';

type Grants = Map<MatrixRole, ReadonlySet<PermissionKey>>;

@Injectable()
export class PermissionsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionsService.name);
  private grants: Grants | null = null;
  private version: number | null = null;
  // Granted keys per sorted role set; emptied on every matrix or settings reload (AC-9, spec 0012)
  private readonly keyCache = new Map<string, ReadonlySet<PermissionKey>>();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

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
      if (versions.matrix !== this.version) await this.load(false);
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
   * The union of the grants of every matrix role held; any other role grants nothing (AC-5).
   * A key whose module is off is left out, whatever the matrix says (spec 0012, AC-10).
   */
  keysFor(roles: readonly string[]): ReadonlySet<PermissionKey> {
    const held = [...new Set(roles.filter(isMatrixRole))].sort();
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

  /** The first load: the matrix with its backfill, and the settings. */
  private async loadCold() {
    if (!this.grants) await this.load(true);
    if (!this.settings.isReady) {
      await this.settings.load();
      this.keyCache.clear();
    }
  }

  /** Runs one load at a time; concurrent requests wait for the same one. */
  private load(withBackfill: boolean): Promise<void> {
    this.loading ??= (async () => {
      try {
        if (withBackfill) await this.backfill();
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

    const grants: Grants = new Map();
    for (const role of MATRIX_ROLES) {
      const keys = new Set<PermissionKey>();
      for (const entry of PERMISSION_CATALOG) {
        // A locked cell ignores its row (AC-4); a missing row denies (AC-6)
        const allowed = isLocked(entry, role)
          ? entry.defaults[role]
          : stored.get(`${role}|${entry.key}`) === true;
        if (allowed) keys.add(entry.key);
      }
      grants.set(role, keys);
    }

    this.grants = grants;
    this.version = version;
    this.keyCache.clear();
  }

  /**
   * Inserts every missing role and key row from the catalog defaults, and never updates or
   * deletes one, so an Admin's edit survives restarts, deploys and rollbacks (AC-3).
   */
  private async backfill() {
    const inserted = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${BACKFILL_LOCK_ID}::bigint)::text`;

      const existing = await tx.rolePermission.findMany({
        select: { role: true, permission: true },
      });
      const have = new Set(existing.map((r) => `${r.role}|${r.permission}`));
      const missing = MATRIX_ROLES.flatMap((role) =>
        PERMISSION_CATALOG.filter(
          (entry) => !have.has(`${role}|${entry.key}`),
        ).map((entry) => ({
          role,
          permission: entry.key,
          allowed: entry.defaults[role],
        })),
      );
      if (missing.length === 0) return 0;

      await tx.rolePermission.createMany({ data: missing });
      // A null actor is System
      await tx.permissionChange.createMany({
        data: missing.map((m) => ({
          role: m.role,
          permission: m.permission,
          before: null,
          after: m.allowed,
        })),
      });
      await tx.permissionMatrix.update({
        where: { id: 1 },
        data: { version: { increment: 1 } },
      });
      return missing.length;
    });

    if (inserted > 0) {
      this.logger.log(`Permission backfill inserted ${inserted} rows`);
    }
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
