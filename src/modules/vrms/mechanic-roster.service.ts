import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { AccountCheck, type AuthUser } from '../../auth/account-check';
import { SystemType, UserRole } from '../../auth/roles';
import {
  AuthDirectoryClient,
  DirectoryUnavailableError,
  type DirectoryUser,
} from './directory/auth-directory.client';
import { authUnavailable } from '../../auth/verify/errors';

/** The client `apply` writes through: the service's own, or a transaction's. */
type Db = Prisma.TransactionClient;

/** What applying one directory person did to their row (spec 0005, AC-13). */
export type ApplyOutcome = 'created' | 'updated' | 'deactivated' | 'unchanged';

// Spec 0009, AC-13 and AC-14: in house Mechanic rows follow the welinc-auth users who hold a VRMS
// mechanic or chief mechanic role. Rows are never deleted. Every Mechanic row is in house (spec
// 0010). Spec 0005: what welinc-auth says arrives through its directory (DirectorySync's poll and
// full read, refreshOne's lookup); VRMS never lists every user.

const MECHANIC_ROLES: string[] = [UserRole.MECHANIC, UserRole.CHIEF_MECHANIC];

/** The VRMS role a roster row stores (spec 0022, AC-4). */
export type MechanicRole = 'MECHANIC' | 'CHIEF_MECHANIC';

type Wanted = {
  name: string;
  email: string;
  isActive: boolean;
  role: MechanicRole;
};

export type SyncResult = {
  created: number;
  updated: number;
  deactivated: number;
};

function isMechanicRole(r: { role: string; system: string }) {
  return r.system === SystemType.VRMS && MECHANIC_ROLES.includes(r.role);
}

/**
 * Spec 0022, AC-4: the person's VRMS mechanic role, or null when they hold none. Other systems'
 * roles are ignored, and Chief Mechanic wins if both somehow appear.
 */
export function roleOf(
  roles: readonly { role: string; system: string }[],
): MechanicRole | null {
  const mine = roles.filter(isMechanicRole).map((r) => r.role);
  if (mine.includes(UserRole.CHIEF_MECHANIC)) return UserRole.CHIEF_MECHANIC;
  if (mine.includes(UserRole.MECHANIC)) return UserRole.MECHANIC;
  return null;
}

function isUniqueViolation(err: unknown) {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

@Injectable()
export class MechanicRoster implements OnModuleInit {
  private readonly logger = new Logger(MechanicRoster.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountCheck: AccountCheck,
    private readonly people: AuthDirectoryClient,
  ) {}

  onModuleInit() {
    this.accountCheck.whenConfirmed((user) => this.ensure(user));
  }

  /**
   * Just in time (AC-13): a mechanic confirmed by welinc-auth gets an active row with their current
   * name and email before the request runs. Writes only when something differs; a failure is
   * logged and never fails the request.
   */
  async ensure(user: AuthUser): Promise<void> {
    const role = roleOf(user.roles);
    if (!role) return;
    // welinc-auth only answers 200 for an active, unlocked user
    const wanted: Wanted = {
      name: user.name,
      email: user.email.toLowerCase(),
      isActive: true,
      role,
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
   * A VRMS mechanic role and not deleted: the row is created or updated. No mechanic role, or
   * deleted: an existing row goes inactive and keeps its last role; no row means nothing to do.
   * Applying the same person twice changes nothing. Runs inside the caller's transaction when
   * given one, so a change and the cursor that passes it commit together.
   */
  async apply(
    user: DirectoryUser,
    db: Db = this.prisma,
  ): Promise<ApplyOutcome> {
    const role = user.deleted
      ? null
      : roleOf(
          user.roles.map((code) => ({ role: code, system: SystemType.VRMS })),
        );
    const row = await db.mechanic.findUnique({
      where: { authUserId: user.id },
      select: { name: true, email: true, isActive: true, role: true },
    });

    if (!role) {
      if (!row?.isActive) return 'unchanged';
      await db.mechanic.update({
        where: { authUserId: user.id },
        data: { isActive: false },
      });
      return 'deactivated';
    }

    const want: Wanted = {
      name: user.name,
      email: user.email.toLowerCase(),
      isActive: user.isActive,
      role,
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
    },
    want: Wanted,
  ) {
    return (
      row.name !== want.name ||
      row.email !== want.email ||
      row.isActive !== want.isActive ||
      row.role !== want.role
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
