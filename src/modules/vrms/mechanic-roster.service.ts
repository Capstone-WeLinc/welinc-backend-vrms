import {
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
  authServiceUrl,
  type AuthUser,
  UNAVAILABLE,
} from '../../auth/account-check';
import { SystemType, UserRole } from '../../auth/roles';

// Spec 0009, AC-11, AC-13 and AC-14: in house Mechanic rows follow the welinc-auth users who hold a
// VRMS mechanic or chief mechanic role. Rows are never deleted. Every Mechanic row is in house (spec 0010).

const MECHANIC_ROLES: string[] = [UserRole.MECHANIC, UserRole.CHIEF_MECHANIC];

/** One user from welinc-auth's `GET /auth/users` answer, the fields the sync reads. */
type AuthUserRow = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  isLocked: boolean;
  roles: { role: string; system: string }[];
};

type Wanted = { name: string; email: string; isActive: boolean };

export type SyncResult = {
  created: number;
  updated: number;
  deactivated: number;
};

function isMechanicRole(r: { role: string; system: string }) {
  return r.system === SystemType.VRMS && MECHANIC_ROLES.includes(r.role);
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
  ) {
    this.usersUrl = `${authServiceUrl(env)}/auth/users?system=${SystemType.VRMS}`;
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
    if (!user.roles.some(isMechanicRole)) return;
    // welinc-auth only answers 200 for an active, unlocked user
    const wanted: Wanted = {
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

  /** AC-11: makes the in house rows match welinc-auth's VRMS users, asking as the calling admin. */
  async sync(token: string): Promise<SyncResult> {
    const body = await askAuth(this.usersUrl, token, this.logger);
    const users = readUsers(body);
    if (!users) {
      this.logger.warn(
        'welinc-auth answered 200 with a user list VRMS cannot read',
      );
      throw new ServiceUnavailableException(UNAVAILABLE);
    }

    const wanted = new Map<string, Wanted>();
    for (const u of users) {
      if (!u.roles.some(isMechanicRole)) continue;
      wanted.set(u.id, {
        name: u.name,
        email: u.email.toLowerCase(),
        isActive: u.isActive && !u.isLocked,
      });
    }

    const rows = await this.prisma.mechanic.findMany({
      select: {
        id: true,
        authUserId: true,
        name: true,
        email: true,
        isActive: true,
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

  private differs(
    row: { name: string; email: string | null; isActive: boolean },
    want: Wanted,
  ) {
    return (
      row.name !== want.name ||
      row.email !== want.email ||
      row.isActive !== want.isActive
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
