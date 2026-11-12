import 'dotenv/config';
import { writeFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

// Suite spec 0013, AC-28: the one time move of the matrix to welinc-auth.
// `npm run permissions:export -- <file>` writes every role_permissions cell and every
// permission_changes row to a JSON file, read in one snapshot. welinc-auth's
// `npm run permissions:import -- VRMS <file>` reads it. Rollout order: catalog:sync in welinc-auth,
// then this export and the import, then the VRMS sync, then the VRMS removals.

/** The file shape both scripts agree on. */
export type PermissionsExport = {
  format: 'welinc-permissions-export';
  formatVersion: 1;
  system: 'VRMS';
  exportedAt: string;
  cells: { role: string; key: string; allowed: boolean }[];
  changes: {
    role: string;
    key: string;
    before: boolean | null;
    after: boolean | null;
    actorId: string | null;
    actorName: string | null;
    actorEmail: string | null;
    note: string | null;
    createdAt: string;
  }[];
};

const file = process.argv[2];
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main(): Promise<number> {
  if (!file) {
    console.error('Usage: npm run permissions:export -- <file>');
    return 1;
  }
  const { cells, changes } = await prisma.$transaction(
    async (tx) => ({
      cells: await tx.rolePermission.findMany({
        select: { role: true, permission: true, allowed: true },
        orderBy: [{ role: 'asc' }, { permission: 'asc' }],
      }),
      changes: await tx.permissionChange.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    }),
    { isolationLevel: 'RepeatableRead' },
  );

  const out: PermissionsExport = {
    format: 'welinc-permissions-export',
    formatVersion: 1,
    system: 'VRMS',
    exportedAt: new Date().toISOString(),
    cells: cells.map((c) => ({ role: c.role, key: c.permission, allowed: c.allowed })),
    changes: changes.map((c) => ({
      role: c.role,
      key: c.permission,
      before: c.before,
      after: c.after,
      actorId: c.actorUserId,
      actorName: c.actorName,
      actorEmail: c.actorEmail,
      note: c.note,
      createdAt: c.createdAt.toISOString(),
    })),
  };
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${out.cells.length} cells and ${out.changes.length} changes to ${file}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error('Export failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
