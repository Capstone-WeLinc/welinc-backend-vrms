import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
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
import { referenceProblem, seedGuard } from './seeds/guard';

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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * `npm run seed -- --reference` (spec 0008, AC-15): garages, vehicles, the knowledge base and the
 * settings defaults, no people and no tickets, into an empty database only. Production runs this.
 * One transaction: a failure part way leaves nothing behind, so a rerun works.
 */
async function seedReference() {
  const problem = await prisma.$transaction(
    async (tx) => {
      // Counted inside the transaction, so two runs at once can't both see an empty database
      const found = referenceProblem({
        garages: await tx.garage.count(),
        vehicles: await tx.vehicle.count(),
        knowledgeEntries: await tx.knowledgeEntry.count(),
      });
      if (found) return found;

      console.log('Seeding reference data only (no people, no tickets)...\n');
      await seedGarages(tx);
      await seedVehicles(tx);
      await seedKnowledge(tx, Date.now(), { reference: true });
      await seedSettings(tx);
      return null;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      // A cold hosted server is slow; the default 5 seconds is too short for 70 vehicles
      timeout: 120_000,
      maxWait: 30_000,
    },
  );
  if (problem) fail(problem);
  console.log('Reference data seeded.');
}

async function main() {
  // AC-13: decided before the first query
  const decision = seedGuard({
    nodeEnv: process.env['NODE_ENV'],
    seedAllow: process.env['SEED_ALLOW'],
    args: process.argv.slice(2),
  });
  if (!decision.ok) fail(decision.message);
  if (decision.mode === 'reference') return seedReference();

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
  await prisma.$transaction((tx) => seedSettings(tx));

  console.log('Database seeded successfully!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(
    'VRMS logins (accounts live in welinc-auth; run its seed too). Every seed account is in docs/integration/seed-accounts.md:',
  );
  console.log('  Admin          → vrms.admin@welinc.com    password: admin1234');
  console.log('  Chief Mechanic → vrms.chief@welinc.com    password: chief1234');
  console.log('  Mechanic       → mech.juan@welinc.com     password: mechanic1234');
  console.log('  Two systems    → multi.chief@welinc.com   password: chief1234');
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
