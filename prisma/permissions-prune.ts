import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { catalogEntry, isMatrixRole } from '../src/auth/permissions/catalog';

// Spec 0011, AC-3: the startup backfill never deletes, so rows for a key that left the catalog
// stay (and deny). `npm run permissions:prune` removes them on purpose, logging each one.

const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const removed = await prisma.$transaction(async (tx) => {
    const rows = await tx.rolePermission.findMany({
      select: { role: true, permission: true, allowed: true },
    });
    const stale = rows.filter(
      (r) => !isMatrixRole(r.role) || !catalogEntry(r.permission),
    );
    if (stale.length === 0) return stale;

    await tx.rolePermission.deleteMany({
      where: {
        OR: stale.map((r) => ({ role: r.role, permission: r.permission })),
      },
    });
    // A null after is a removed row; a null actor is System
    await tx.permissionChange.createMany({
      data: stale.map((r) => ({
        role: r.role,
        permission: r.permission,
        before: r.allowed,
        after: null,
        note: 'Pruned: no longer in the catalog',
      })),
    });
    await tx.permissionMatrix.update({
      where: { id: 1 },
      data: { version: { increment: 1 } },
    });
    return stale;
  });

  for (const r of removed) {
    console.log(`Removed ${r.role} ${r.permission} (was ${r.allowed})`);
  }
  console.log(
    removed.length === 0
      ? 'Nothing to prune: every row matches the catalog.'
      : `Pruned ${removed.length} rows.`,
  );
}

main()
  .catch((e) => {
    console.error('Prune failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
