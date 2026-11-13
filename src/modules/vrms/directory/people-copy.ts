import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import type { DirectoryUser } from './auth-directory.client';

// Suite spec 0014 (task 13a, "VRMS Users page source"): VRMS keeps every person who holds a VRMS
// role, permanent or temporary, from the directory feed it already reads, and the Users page lists
// them from here instead of welinc-auth's GET /auth/users.

/** One person on the Users page. `roles` keeps the `{ role, system }` shape the page reads. */
export type TeamPerson = {
  id: string;
  name: string;
  email: string;
  picture: string | null;
  roles: { role: string; system: 'VRMS' }[];
  temporaryRoles: string[];
  isActive: boolean;
  deleted: boolean;
};

type Writer = Pick<Prisma.TransactionClient, 'vrmsPerson'>;

/**
 * Applies one directory snapshot inside the caller's transaction. An erased person, or one with
 * no VRMS role left, loses their row; anyone else is written as the snapshot says. Applying the
 * same snapshot again changes nothing more.
 */
export async function applyPerson(
  tx: Writer,
  user: DirectoryUser,
): Promise<void> {
  if (user.erased || user.roles.length === 0) {
    await tx.vrmsPerson.deleteMany({ where: { authUserId: user.id } });
    return;
  }
  const temporary = user.temporaryRoles ?? [];
  const data = {
    name: user.name,
    email: user.email.toLowerCase(),
    picture: user.picture,
    roles: user.roles,
    temporaryRoles: user.roles.filter((role) => temporary.includes(role)),
    isActive: user.isActive,
    deleted: user.deleted,
  };
  await tx.vrmsPerson.upsert({
    where: { authUserId: user.id },
    create: { authUserId: user.id, ...data },
    update: data,
  });
}

/** After a full read: everyone the directory no longer lists has left VRMS. */
export async function sweepPeople(
  tx: Writer,
  seen: ReadonlySet<string>,
): Promise<number> {
  const { count } = await tx.vrmsPerson.deleteMany({
    where: { authUserId: { notIn: [...seen] } },
  });
  return count;
}

export function toTeamPerson(row: {
  authUserId: string;
  name: string;
  email: string;
  picture: string | null;
  roles: string[];
  temporaryRoles: string[];
  isActive: boolean;
  deleted: boolean;
}): TeamPerson {
  return {
    id: row.authUserId,
    name: row.name,
    email: row.email,
    picture: row.picture,
    roles: row.roles.map((role) => ({ role, system: 'VRMS' as const })),
    temporaryRoles: row.temporaryRoles,
    isActive: row.isActive,
    deleted: row.deleted,
  };
}

@Injectable()
export class PeopleCopy {
  constructor(private readonly prisma: PrismaService) {}

  /** `GET /vrms/people`: everyone in the copy, by name then email. */
  async list(): Promise<TeamPerson[]> {
    const rows = await this.prisma.vrmsPerson.findMany({
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
    });
    return rows.map(toTeamPerson);
  }
}
