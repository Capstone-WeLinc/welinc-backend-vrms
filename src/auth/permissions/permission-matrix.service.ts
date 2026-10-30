import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../shared/prisma.service';
import { decodeCursor, encodeCursor } from '../../modules/vrms/audit-events';
import { NOTE_MIN, NOTE_MAX } from '../../settings/settings-rules';
import type { AuthUser } from '../account-check';
import {
  catalogEntry,
  isLocked,
  isMatrixRole,
  MATRIX_ROLES,
  PERMISSION_CATALOG,
  ROLE_LABELS,
} from './catalog';
import type {
  ListPermissionChangesQueryDto,
  UpdatePermissionsDto,
} from './dto/update-permissions.dto';

export const STALE_MATRIX =
  'The permissions were changed by someone else. Reload to see the latest.';

const CHANGES_PAGE_SIZE = 50;

const cell = (role: string, permission: string) => `${role}|${permission}`;

/**
 * The matrix API (spec 0011, AC-17 to AC-19). It reads and writes the stored rows directly; each
 * replica's grant cache follows through the version (PermissionsService, AC-20).
 */
@Injectable()
export class PermissionMatrixService {
  private readonly logger = new Logger(PermissionMatrixService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every role and key with its stored value; a locked cell shows its catalog value (AC-4, AC-17). */
  async view() {
    const [matrix, rows] = await Promise.all([
      this.prisma.permissionMatrix.findUniqueOrThrow({
        where: { id: 1 },
        select: { version: true },
      }),
      this.prisma.rolePermission.findMany({
        select: { role: true, permission: true, allowed: true },
      }),
    ]);
    const stored = new Map(
      rows.map((r) => [cell(r.role, r.permission), r.allowed]),
    );

    const groups = new Map<string, unknown[]>();
    for (const entry of PERMISSION_CATALOG) {
      const grants = Object.fromEntries(
        MATRIX_ROLES.map((role) => {
          const locked = isLocked(entry, role);
          // A missing row denies (AC-6)
          const allowed = locked
            ? entry.defaults[role]
            : stored.get(cell(role, entry.key)) === true;
          return [role, { allowed, locked }];
        }),
      );
      const keys = groups.get(entry.group) ?? [];
      keys.push({
        key: entry.key,
        label: entry.label,
        description: entry.description,
        // Spec 0012, AC-24: the Roles section marks keys of an off module
        module: catalogEntry(entry.key)?.module ?? null,
        grants,
      });
      groups.set(entry.group, keys);
    }

    return {
      roles: MATRIX_ROLES.map((role) => ({ role, label: ROLE_LABELS[role] })),
      groups: [...groups].map(([name, keys]) => ({ name, keys })),
      version: matrix.version,
    };
  }

  /**
   * All or nothing, under a row lock on the version (AC-18). Each applied cell writes one
   * PermissionChange row; a change to the value a cell already has is skipped and not logged.
   */
  async update(dto: UpdatePermissionsDto, actor: AuthUser) {
    const seen = new Set<string>();
    for (const change of dto.changes) {
      if (!isMatrixRole(change.role)) {
        throw new BadRequestException(`Unknown role: ${change.role}`);
      }
      const entry = catalogEntry(change.permission);
      if (!entry) {
        throw new BadRequestException(
          `Unknown permission: ${change.permission}`,
        );
      }
      if (isLocked(entry, change.role)) {
        throw new BadRequestException(
          `"${entry.label}" is locked for ${ROLE_LABELS[change.role]}.`,
        );
      }
      const key = cell(change.role, change.permission);
      if (seen.has(key)) {
        throw new BadRequestException(
          `${ROLE_LABELS[change.role]} and ${change.permission} appear twice.`,
        );
      }
      seen.add(key);
    }
    const note = dto.note?.trim() || null;

    const applied = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ version: number }[]>`
        SELECT version FROM permission_matrix WHERE id = 1 FOR UPDATE
      `;
      if (!locked || locked.version !== dto.version) {
        throw new ConflictException(STALE_MATRIX);
      }

      // `before` is read inside the transaction, under the lock (Value sourcing)
      const current = await tx.rolePermission.findMany({
        where: {
          OR: dto.changes.map((c) => ({
            role: c.role,
            permission: c.permission,
          })),
        },
        select: { role: true, permission: true, allowed: true },
      });
      const before = new Map(
        current.map((r) => [cell(r.role, r.permission), r.allowed]),
      );

      const toApply = dto.changes.filter(
        (c) => before.get(cell(c.role, c.permission)) !== c.allowed,
      );
      // Spec 0012, AC-24: taking a right away needs a reason, like a module switch. Adding one
      // does not. Checked here, after the version check, so a stale save still answers 409.
      const removes = toApply.some(
        (c) => !c.allowed && before.get(cell(c.role, c.permission)) === true,
      );
      if (removes && (!note || note.length < NOTE_MIN)) {
        throw new BadRequestException(
          `Taking a right away needs a reason of ${NOTE_MIN} to ${NOTE_MAX} characters.`,
        );
      }

      for (const change of toApply) {
        await tx.rolePermission.upsert({
          where: {
            role_permission: {
              role: change.role,
              permission: change.permission,
            },
          },
          create: {
            role: change.role,
            permission: change.permission,
            allowed: change.allowed,
            updatedByUserId: actor.sub,
          },
          update: { allowed: change.allowed, updatedByUserId: actor.sub },
        });
      }
      if (toApply.length === 0) return 0;

      // The actor comes from the token, never the body (Value sourcing)
      await tx.permissionChange.createMany({
        data: toApply.map((change) => ({
          role: change.role,
          permission: change.permission,
          before: before.get(cell(change.role, change.permission)) ?? null,
          after: change.allowed,
          actorUserId: actor.sub,
          actorName: actor.name,
          actorEmail: actor.email,
          note,
        })),
      });
      await tx.permissionMatrix.update({
        where: { id: 1 },
        data: { version: { increment: 1 } },
      });
      return toApply.length;
    });

    if (applied > 0) {
      this.logger.log(
        `Permission matrix: ${applied} cells changed by ${actor.email}`,
      );
    }
    return this.view();
  }

  /** Newest first, keyset paged on (createdAt, id) like spec 0009's change record (AC-19). */
  async changes(query: ListPermissionChangesQueryDto) {
    const limit = query.limit ?? CHANGES_PAGE_SIZE;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.prisma.permissionChange.findMany({
      where: cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {},
      select: {
        id: true,
        role: true,
        permission: true,
        before: true,
        after: true,
        actorName: true,
        actorEmail: true,
        note: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      data: page,
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }
}
