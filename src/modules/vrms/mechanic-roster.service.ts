import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { AccountCheck, type AuthUser } from '../../auth/account-check';
import { SystemType } from '../../auth/roles';
import type { PermissionKey } from '../../auth/permissions/catalog';
import {
  PermissionsService,
  type LoadedGrants,
} from '../../auth/permissions/permissions.service';
import { widestRole } from '../../auth/permissions/widest-role';
import {
  AuthDirectoryClient,
  DirectoryUnavailableError,
  permanentRoles,
  type DirectoryUser,
} from './directory/auth-directory.client';
import { authUnavailable } from '../../auth/verify/errors';

/** The client `apply` writes through: the service's own, or a transaction's. */
type Db = Prisma.TransactionClient;

/** What applying one directory person did to their row (spec 0005, AC-13). */
export type ApplyOutcome = 'created' | 'updated' | 'deactivated' | 'unchanged';

// Spec 0009, AC-13 and AC-14: in house Mechanic rows follow the welinc-auth users VRMS can assign
// tickets to. Rows are never deleted. Every Mechanic row is in house (spec 0010). Spec 0005: what
// welinc-auth says arrives through its directory (DirectorySync's poll and full read, refreshOne's
// lookup); VRMS never lists every user.
//
// Suite spec 0018 child 0002, AC-33 and AC-34: who is on the roster is decided by permissions, never
// by a role code. A person whose VRMS roles grant `ticket.assignable` (in the synced grants) gets
// an assignable row; `ticket.verify` makes them a lead. Losing the key sets `assignable` false and
// keeps the row active (still a VRMS person, still on their open tickets). Nothing is decided until
// this process has loaded grants that carry `ticket.assignable`, so a cold start or the gap before
// welinc-auth sends the key never empties the roster.

/** The key that puts a person on the roster (child 0002, AC-33). */
export const ASSIGNABLE_KEY: PermissionKey = 'ticket.assignable';
/** The key that makes a roster person a lead (child 0002, AC-34). */
export const LEAD_KEY: PermissionKey = 'ticket.verify';

/** What a person's VRMS roles make them on the roster. */
export type Standing = {
  /** Their widest VRMS role, stored in `mechanics.role`. */
  role: string;
  assignable: boolean;
  isLead: boolean;
};

type Wanted = Standing & {
  name: string;
  email: string;
  isActive: boolean;
};

export type SyncResult = {
  created: number;
  updated: number;
  deactivated: number;
};

/** A person as the roster needs them: permanent VRMS roles only (suite spec 0013, AC-11). */
type Person = Pick<
  DirectoryUser,
  'id' | 'name' | 'email' | 'isActive' | 'deleted'
> & {
  roles: readonly string[];
};

/**
 * Child 0002, AC-33 and AC-34: a person's standing from their VRMS role codes and the keys those
 * roles grant, or null when they hold no VRMS role.
 */
export function standingOf(
  roles: readonly string[],
  keysFor: (roles: readonly string[]) => ReadonlySet<string>,
): Standing | null {
  const role = widestRole(roles);
  if (role === null) return null;
  const keys = keysFor(roles);
  return {
    role,
    assignable: keys.has(ASSIGNABLE_KEY),
    isLead: keys.has(LEAD_KEY),
  };
}

/** Which roles grant the two roster keys: a reload that leaves it alone needs no recompute. */
export function rosterSignature(loaded: LoadedGrants): string | null {
  if (!loaded.syncedKeys.has(ASSIGNABLE_KEY)) return null;
  return [...loaded.grants]
    .map(
      ([role, keys]) =>
        `${role}:${keys.has(ASSIGNABLE_KEY) ? 1 : 0}${keys.has(LEAD_KEY) ? 1 : 0}`,
    )
    .sort()
    .join(',');
}

function isUniqueViolation(err: unknown) {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

@Injectable()
export class MechanicRoster implements OnModuleInit {
  private readonly logger = new Logger(MechanicRoster.name);

  private signature: string | null = null;
  private recomputing: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountCheck: AccountCheck,
    private readonly people: AuthDirectoryClient,
    private readonly permissions: PermissionsService,
  ) {}

  onModuleInit() {
    this.accountCheck.whenConfirmed((user) => this.ensure(user));
    // Child 0002, AC-33: the first load that carries the key, and every change to who holds the two
    // roster keys, recompute the whole roster
    this.permissions.whenLoaded((loaded) => {
      const next = rosterSignature(loaded);
      if (next === null || next === this.signature) return;
      this.recomputing = this.recomputing.then(async () => {
        // Recorded only once a recompute ran, so a skipped one is tried again on the next load
        if ((await this.recompute()) !== null) this.signature = next;
      });
    });
  }

  /**
   * True once this process has loaded grants that carry `ticket.assignable` (child 0002, AC-33).
   * Only the grants count: the settings load after them on a cold start, and the roster reads none.
   */
  private get ready(): boolean {
    return this.permissions.hasSynced(ASSIGNABLE_KEY);
  }

  private standing(roles: readonly string[]): Standing | null {
    return standingOf(roles, (r) => this.permissions.keysFor(r));
  }

  /**
   * Child 0002, AC-33: every VRMS person (welinc-auth's directory, copied into `vrms_people`) applied
   * again from the current grants. Never throws; a failure waits for the next change.
   */
  async recompute(): Promise<SyncResult | null> {
    if (!this.ready) return null;
    try {
      const people = await this.prisma.vrmsPerson.findMany({
        select: {
          authUserId: true,
          name: true,
          email: true,
          roles: true,
          temporaryRoles: true,
          isActive: true,
          deleted: true,
        },
      });
      const result: SyncResult = { created: 0, updated: 0, deactivated: 0 };
      for (const p of people) {
        const outcome = await this.applyPerson(
          {
            id: p.authUserId,
            name: p.name,
            email: p.email,
            isActive: p.isActive,
            deleted: p.deleted,
            roles: permanentRoles(p),
          },
          this.prisma,
        );
        if (outcome !== 'unchanged') result[outcome] += 1;
      }
      this.logger.log(
        `Roster recomputed from the grants: ${result.created} created, ${result.updated} updated, ${result.deactivated} deactivated`,
      );
      return result;
    } catch (err) {
      this.logger.error(
        `Could not recompute the roster: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Just in time (AC-13): a person whose VRMS roles grant `ticket.assignable` gets an active,
   * assignable row with their current name and email before the request runs. Never takes a row
   * away (the directory does that). Writes only when something differs; a failure is logged and
   * never fails the request.
   */
  async ensure(user: AuthUser): Promise<void> {
    if (!this.ready) return;
    const standing = this.standing(
      user.roles.filter((r) => r.system === SystemType.VRMS).map((r) => r.role),
    );
    if (!standing?.assignable) return;
    // welinc-auth only answers 200 for an active, unlocked user
    const wanted: Wanted = {
      ...standing,
      name: user.name,
      email: user.email.toLowerCase(),
      isActive: true,
    };
    try {
      const row = await this.prisma.mechanic.findUnique({
        where: { authUserId: user.sub },
      });
      if (row && !this.differs(row, wanted)) return;
      await this.write(user.sub, wanted);
    } catch (err) {
      this.logger.error(
        `Could not ensure the Mechanic row for ${user.sub}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Spec 0005, AC-18 (and spec 0011, AC-33): brings one person's row in step with welinc-auth at
   * once, through the directory lookup instead of listing every user. A person in `missing`
   * (never in VRMS, or hard deleted) has an existing row set inactive. Returns the row after, or
   * null when there is none and nothing to create. welinc-auth unavailable: 503 `AUTH_UNAVAILABLE`.
   */
  async refreshOne(
    authUserId: string,
  ): Promise<{ mechanicId: string; stillActive: boolean } | null> {
    let found: DirectoryUser | undefined;
    try {
      const answer = await this.people.lookup([authUserId]);
      found = answer.users.find((user) => user.id === authUserId);
    } catch (error) {
      if (error instanceof DirectoryUnavailableError) {
        this.logger.warn(`Could not refresh ${authUserId}: ${error.reason}`);
        throw authUnavailable();
      }
      throw error;
    }

    if (found) {
      await this.apply(found);
    } else {
      await this.prisma.mechanic.updateMany({
        where: { authUserId, isActive: true },
        data: { isActive: false },
      });
    }

    const row = await this.prisma.mechanic.findUnique({
      where: { authUserId },
      select: { id: true, isActive: true },
    });
    return row ? { mechanicId: row.id, stillActive: row.isActive } : null;
  }

  /**
   * Spec 0005, AC-13: brings one person's row in step with what welinc-auth's directory says.
   * A VRMS role and not deleted: the row is created or updated with what the grants make them
   * (assignable, lead), but a person who was never assignable gets no row. No VRMS role, or
   * deleted: an existing row goes inactive and keeps its last role; no row means nothing to do.
   * Applying the same person twice changes nothing. Runs inside the caller's transaction when
   * given one, so a change and the cursor that passes it commit together.
   */
  async apply(
    user: DirectoryUser,
    db: Db = this.prisma,
  ): Promise<ApplyOutcome> {
    // Suite spec 0013, AC-11: a temporary role never makes a roster mechanic
    return this.applyPerson({ ...user, roles: permanentRoles(user) }, db);
  }

  private async applyPerson(user: Person, db: Db): Promise<ApplyOutcome> {
    // Child 0002, AC-33: before the grants carry the key, the row stays as stored
    if (!this.ready) return 'unchanged';
    const standing = user.deleted ? null : this.standing(user.roles);
    const row = await db.mechanic.findUnique({
      where: { authUserId: user.id },
      select: {
        name: true,
        email: true,
        isActive: true,
        role: true,
        assignable: true,
        isLead: true,
      },
    });

    if (!standing) {
      if (!row?.isActive) return 'unchanged';
      await db.mechanic.update({
        where: { authUserId: user.id },
        data: { isActive: false },
      });
      return 'deactivated';
    }
    // Someone who was never assignable gets no row
    if (!row && !standing.assignable) return 'unchanged';

    const want: Wanted = {
      ...standing,
      name: user.name,
      email: user.email.toLowerCase(),
      isActive: user.isActive,
    };
    if (row && !this.differs(row, want)) return 'unchanged';
    const wasActive = row?.isActive ?? false;
    // A native upsert (INSERT ... ON CONFLICT), so a just in time insert racing it can't fail it
    await db.mechanic.upsert({
      where: { authUserId: user.id },
      create: { authUserId: user.id, ...want },
      update: want,
    });
    if (!row) return 'created';
    return wasActive && !want.isActive ? 'deactivated' : 'updated';
  }

  private differs(
    row: {
      name: string;
      email: string | null;
      isActive: boolean;
      role: string | null;
      assignable: boolean;
      isLead: boolean;
    },
    want: Wanted,
  ) {
    return (
      row.name !== want.name ||
      row.email !== want.email ||
      row.isActive !== want.isActive ||
      row.role !== want.role ||
      row.assignable !== want.assignable ||
      row.isLead !== want.isLead
    );
  }

  /**
   * Upserts on authUserId. When a concurrent writer wins the insert (a unique violation), reads
   * the row again and updates it only if it still differs, so the counts stay honest.
   */
  private async write(
    authUserId: string,
    want: Wanted,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    try {
      const before = await this.prisma.mechanic.findUnique({
        where: { authUserId },
        select: { id: true },
      });
      await this.prisma.mechanic.upsert({
        where: { authUserId },
        create: { authUserId, ...want },
        update: want,
      });
      return before ? 'updated' : 'created';
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const row = await this.prisma.mechanic.findUnique({
        where: { authUserId },
      });
      if (!row || !this.differs(row, want)) return 'unchanged';
      await this.prisma.mechanic.update({ where: { authUserId }, data: want });
      return 'updated';
    }
  }
}
