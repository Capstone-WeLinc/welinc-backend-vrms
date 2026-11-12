import { PrismaClient } from '@prisma/client';

/**
 * Suite spec 0013, AC-29: the matrix comes from welinc-auth, so a reset no longer writes cells.
 * It clears the stored ETag instead, so the next sync tick (within 60 s, or at startup) applies
 * welinc-auth's current matrix again whatever this database holds. The cells stay meanwhile.
 */
export async function seedPermissions(prisma: PrismaClient) {
  await prisma.permissionSyncState.updateMany({
    where: { id: 'auth' },
    data: { etag: null },
  });
  console.log(
    'Permission matrix: the next sync applies welinc-auth\'s matrix again',
  );
}
