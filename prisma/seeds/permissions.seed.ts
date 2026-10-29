import { PrismaClient } from '@prisma/client';
import {
  MATRIX_ROLES,
  PERMISSION_CATALOG,
} from '../../src/auth/permissions/catalog';

/**
 * Resets the permission matrix to the catalog defaults, so a local reset starts clean
 * (spec 0011). Production never runs the seed; there the startup backfill only inserts.
 */
export async function seedPermissions(prisma: PrismaClient) {
  const rows = MATRIX_ROLES.flatMap((role) =>
    PERMISSION_CATALOG.map((entry) => ({
      role,
      permission: entry.key,
      allowed: entry.defaults[role],
    })),
  );

  await prisma.$transaction([
    prisma.permissionChange.deleteMany({}),
    prisma.rolePermission.deleteMany({}),
    prisma.rolePermission.createMany({ data: rows }),
    // A null actor is System, as for the startup backfill
    prisma.permissionChange.createMany({
      data: rows.map((r) => ({
        role: r.role,
        permission: r.permission,
        before: null,
        after: r.allowed,
      })),
    }),
    // Every running replica reloads on its next request
    prisma.permissionMatrix.update({
      where: { id: 1 },
      data: { version: { increment: 1 } },
    }),
  ]);
  console.log(`Permission matrix reset to the defaults (${rows.length} rows)`);
}
