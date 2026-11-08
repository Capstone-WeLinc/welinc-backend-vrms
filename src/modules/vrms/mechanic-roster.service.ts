import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService as EnvConfig } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import {
  AccountCheck,
  askAuth,
  authInternalUrl,
  type AuthUser,
  UNAVAILABLE,
} from '../../auth/account-check';
import { SystemType, UserRole } from '../../auth/roles';
import { DIRECTORY_TOKENS, ServiceTokenClient } from '../../auth/verify';
import type { DirectoryUser } from './directory/auth-directory.client';

/** The client `apply` writes through: the service's own, or a transaction's. */
type Db = Prisma.TransactionClient;

/** What applying one directory person did to their row (spec 0005, AC-13). */
export type ApplyOutcome = 'created' | 'updated' | 'deactivated' | 'unchanged';

// Spec 0009, AC-11, AC-13 and AC-14: in house Mechanic rows follow the welinc-auth users who hold a
// VRMS mechanic or chief mechanic role. Rows are never deleted. Every Mechanic row is in house (spec 0010).

const MECHANIC_ROLES: string[] = [UserRole.MECHANIC, UserRole.CHIEF_MECHANIC];

/** The VRMS role a roster row stores (spec 0022, AC-4). */
export type MechanicRole = 'MECHANIC' | 'CHIEF_MECHANIC';

/** One user from welinc-auth's `GET /auth/users` answer, the fields the sync reads. */
type AuthUserRow = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  isLocked: boolean;
  roles: { role: string; system: string }[];
};

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

function readUsers(body: unknown): AuthUserRow[] | null {
  if (!Array.isArray(body)) return null;
  const users = body.filter(
    (u): u is AuthUserRow =>
      typeof u === 'object' &&
      u !== null &&
      typeof (u as AuthUserRow).id === 'string' &&
      typeof (u as AuthUserRow).name === 'string' &&
      typeof (u as AuthUserRow).email === 'string' &&
      typeof (u as AuthUserRow).isActive === 'boolean' &&
      Array.isArray((u as AuthUserRow).roles),
  );
  return users.length === body.length ? users : null;
}

@Injectable()
export class MechanicRoster implements OnModuleInit {
  private readonly logger = new Logger(MechanicRoster.name);
  private readonly usersUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountCheck: AccountCheck,
    env: EnvConfig,
    @Inject(DIRECTORY_TOKENS) private readonly directory: ServiceTokenClient,
  ) {
    this.usersUrl = `${authInternalUrl(env)}/auth/users?system=${SystemType.VRMS}`;
  }

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
   * Asks welinc-auth for the VRMS users with VRMS's own service token (spec 0002, AC-21), never a
   * caller's, so a Chief Mechanic's action and background work need no admin token. No token: 503.
   */
  private async fetchUsers(): Promise<AuthUserRow[]> {
    const body = await this.directory.withToken((token) =>
      askAuth(this.usersUrl, token, this.logger),
    );
    const users = readUsers(body);
    if (!users) {
      this.logger.warn(
        'welinc-auth answered 200 with a user list VRMS cannot read',
      );
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
    return users;
  }

  /**
   * Spec 0011, AC-33: brings one person's Mechanic row in step with welinc-auth and says whether they
   * still hold access to VRMS as a mechanic (active account, mechanic role). Returns null when there
   * is no Mechanic row for them.
   */
  async refreshOne(
    authUserId: string,
  ): Promise<{ mechanicId: string; stillActive: boolean } | null> {
    const users = await this.fetchUsers();
    const row = await this.prisma.mechanic.findUnique({
      where: { authUserId },
      select: { id: true, name: true, email: true, isActive: true, role: true },
    });
    if (!row) return null;
    const found = users.find((u) => u.id === authUserId);
    const role = found ? roleOf(found.roles) : null;
    // No VRMS mechanic role any more: the row keeps its last known role (AC-4)
    if (!found || !role) {
      if (row.isActive) {
        await this.prisma.mechanic.update({
          where: { authUserId },
          data: { isActive: false },
        });
      }
      return { mechanicId: row.id, stillActive: false };
    }
    const want: Wanted = {
      name: found.name,
      email: found.email.toLowerCase(),
      isActive: found.isActive,
      role,
    };
    if (this.differs(row, want)) await this.write(authUserId, want);
    return { mechanicId: row.id, stillActive: want.isActive };
  }

  /** AC-11: makes the in house rows match welinc-auth's VRMS users, asking as VRMS itself. */
  async sync(): Promise<SyncResult> {
    const users = await this.fetchUsers();

    const wanted = new Map<string, Wanted>();
    for (const u of users) {
      const role = roleOf(u.roles);
      if (!role) continue;
      wanted.set(u.id, {
        name: u.name,
        email: u.email.toLowerCase(),
        // Spec 0011, AC-31: a locked account is still a mechanic; only deactivation or losing the role is not
        isActive: u.isActive,
        role,
      });
    }

    const rows = await this.prisma.mechanic.findMany({
      select: {
        id: true,
        authUserId: true,
        name: true,
        email: true,
        isActive: true,
        role: true,
      },
    });
    const byAuthId = new Map(rows.map((r) => [r.authUserId, r]));

    let created = 0;
    let updated = 0;
    for (const [authUserId, want] of wanted) {
      const row = byAuthId.get(authUserId);
      if (row && !this.differs(row, want)) continue;
      const outcome = await this.write(authUserId, want);
      if (outcome === 'created') created++;
      else if (outcome === 'updated') updated++;
    }

    // A deleted user, or one with no VRMS mechanic role, leaves the picker
    const gone = rows
      .filter((r) => r.isActive && !wanted.has(r.authUserId))
      .map((r) => r.id);
    const { count: deactivated } = gone.length
      ? await this.prisma.mechanic.updateMany({
          where: { id: { in: gone }, isActive: true },
          data: { isActive: false },
        })
      : { count: 0 };

    return { created, updated, deactivated };
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
    // A native upsert (INSERT ... ON CONFLICT), so a just in time insert racing it can't fail it
    await db.mechanic.upsert({
      where: { authUserId: user.id },
      create: { authUserId: user.id, ...want },
      update: want,
    });
    if (!row) return 'created';
    return row.isActive && !want.isActive ? 'deactivated' : 'updated';
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
