import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { settingEntry } from '../src/settings/catalog';

// Spec 0012, AC-2: nothing deletes a stored setting whose key left the catalog (it is ignored).
// `npm run settings:prune` removes such rows on purpose, logging each as a RESET by System.

const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const removed = await prisma.$transaction(async (tx) => {
    const rows = await tx.appSetting.findMany({
      select: { key: true, value: true },
    });
    const stale = rows.filter((r) => !settingEntry(r.key));
    if (stale.length === 0) return stale;

    await tx.appSetting.deleteMany({
      where: { key: { in: stale.map((r) => r.key) } },
    });
    // The key has no catalog default any more, so the effective value after is null as JSON
    await tx.settingChange.createMany({
      data: stale.map((r) => ({
        key: r.key,
        before: r.value ?? 'null',
        after: 'null',
        action: 'RESET',
        note: 'Pruned: no longer in the catalog',
      })),
    });
    await tx.settingsState.update({
      where: { id: 1 },
      data: { version: { increment: 1 } },
    });
    return stale;
  });

  for (const r of removed) {
    console.log(`Removed ${r.key} (was ${JSON.stringify(r.value)})`);
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
