import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

import { seedGarages } from './seeds/garages.seed';
import { seedMechanics } from './seeds/mechanics.seed';
import { seedVehicles } from './seeds/vehicles.seed';
import { seedDrivers } from './seeds/drivers.seed';
import { seedRepairs } from './seeds/repairs.seed';
import { seedKnowledge } from './seeds/knowledge.seed';
import { seedPermissions } from './seeds/permissions.seed';
import { seedSettings } from './seeds/settings.seed';
import { SEED } from './seeds/random';

const pool = new pg.Pool({
  connectionString: process.env['DATABASE_URL'],
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function cleanDatabase(prisma: PrismaClient) {
  console.log('Cleaning database...');
  await prisma.knowledgeSuggestion.deleteMany({});
  await prisma.knowledgeEntryChange.deleteMany({});
  // Audit rows first: the database refuses to delete a ticket that still has them (spec 0010, AC-8).
  // audit_logs is append only (spec 0021, AC-14): its triggers are switched off for this dev reset
  // only, as the table owner, and always switched back on.
  await prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER USER');
  try {
    await prisma.auditLog.deleteMany({});
  } finally {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_logs ENABLE TRIGGER USER',
    );
  }
  // Spec 0017: attachment rows block a ticket delete too. Their blobs become orphans, which the
  // nightly sweep removes after 24 hours.
  await prisma.attachment.deleteMany({});
  await prisma.ticketAssignment.deleteMany({});
  await prisma.repairPart.deleteMany({});
  await prisma.repairIssue.deleteMany({});
  await prisma.repairTicket.deleteMany({});
  // Steps and parts go with their entry; the issue categories belong to the migration and stay
  await prisma.knowledgeEntry.deleteMany({});
  await prisma.driver.deleteMany({});
  await prisma.mechanic.deleteMany({});
  await prisma.vehicleChange.deleteMany({});
  await prisma.vehicle.deleteMany({});
  await prisma.garage.deleteMany({});
  console.log('Database cleaned successfully!\n');
}

async function main() {
  console.log(
    `Seeding database with SEED=${SEED} (the same SEED rebuilds the same data, dated from today)...\n`,
  );
  // One clock for every module, so "today" is the same instant everywhere
  const now = Date.now();

  await cleanDatabase(prisma);
  await seedGarages(prisma);
  await seedMechanics(prisma);
  const vehicles = await seedVehicles(prisma);
  const drivers = await seedDrivers(prisma, now);
  const { entries, categoryId } = await seedKnowledge(prisma, now);
  await seedRepairs(prisma, { now, vehicles, drivers, entries, categoryId });
  await seedPermissions(prisma);
  await seedSettings(prisma);

  console.log('Database seeded successfully!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(
    'Login credentials (accounts live in welinc-auth; run its seed too):',
  );
  console.log(
    '  BMS Admin  → email: bms.admin@welinc.com  password: admin1234',
  );
  console.log(
    '  VRMS Admin → email: vrms.admin@welinc.com password: admin1234',
  );
  console.log(
    '  VMMS Admin → email: vmms.admin@welinc.com password: admin1234',
  );
  console.log(
    '  CS user    → email: cs.user@welinc.com    password: cs1234 (BMS)',
  );
  console.log(
    '  Operations → email: ops.user@welinc.com   password: ops1234 (BMS)',
  );
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
