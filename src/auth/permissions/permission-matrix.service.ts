import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma.service';
import { MATRIX_ROLES, PERMISSION_CATALOG } from './catalog';

const cell = (role: string, permission: string) => `${role}|${permission}`;

/**
 * Spec 0011, AC-17, read only since suite spec 0013 (AC-30): VRMS's synced copy of its matrix,
 * as keys and values. Labels, locks and edits live in welinc-auth's portal Permissions view.
 */
@Injectable()
export class PermissionMatrixService {
  constructor(private readonly prisma: PrismaService) {}

  async view() {
    const [matrix, sync, rows] = await Promise.all([
      this.prisma.permissionMatrix.findUniqueOrThrow({
        where: { id: 1 },
        select: { version: true },
      }),
      this.prisma.permissionSyncState.findUnique({
        where: { id: 'auth' },
        select: { etag: true, syncedAt: true },
      }),
      this.prisma.rolePermission.findMany({
        select: { role: true, permission: true, allowed: true },
      }),
    ]);
    const stored = new Map(
      rows.map((r) => [cell(r.role, r.permission), r.allowed]),
    );
    return {
      version: matrix.version,
      /** The welinc-auth version this copy came from, and when it was applied. */
      source: { etag: sync?.etag ?? null, syncedAt: sync?.syncedAt ?? null },
      roles: [...MATRIX_ROLES],
      keys: PERMISSION_CATALOG.map((entry) => ({
        key: entry.key,
        module: 'module' in entry ? entry.module : null,
        // A missing row denies (AC-6)
        grants: Object.fromEntries(
          MATRIX_ROLES.map((role) => [
            role,
            stored.get(cell(role, entry.key)) === true,
          ]),
        ),
      })),
    };
  }
}
