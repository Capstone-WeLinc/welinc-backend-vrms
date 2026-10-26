import { PrismaClient } from '@prisma/client';
import {
  BULK_MECHANICS,
  CHIEF,
  NAMED_MECHANICS,
  SeedPerson,
} from './shared-ids';

// Accounts live in welinc-auth (spec 0009). This makes the in house Mechanic rows for the people
// welinc-auth's seed gives a VRMS mechanic or chief mechanic role, linked by the shared fixed ids.
export async function seedMechanics(prisma: PrismaClient) {
  console.log('Creating in house mechanics linked to welinc-auth users...');
  const people: SeedPerson[] = [...NAMED_MECHANICS, CHIEF, ...BULK_MECHANICS];
  await prisma.mechanic.createMany({
    data: people.map((p) => ({
      authUserId: p.id,
      email: p.email.toLowerCase(),
      name: p.name,
      isOutsourced: false,
    })),
  });
  console.log(`  ${people.length} in house mechanics created.\n`);
}
