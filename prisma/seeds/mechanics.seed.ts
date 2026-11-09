import { PrismaClient } from '@prisma/client';
import { MANIFEST_PEOPLE, vrmsRole } from './shared-ids';

const MECHANIC_ROLES = new Set(['MECHANIC', 'CHIEF_MECHANIC']);
const INACTIVE_STATES = new Set(['deactivated', 'deleted']);

// Accounts live in welinc-auth (spec 0009). This makes the in house Mechanic rows for every
// manifest person holding a VRMS mechanic or chief mechanic role, linked by the shared fixed ids
// (spec 0006, AC-15). It creates no account anywhere.
export async function seedMechanics(prisma: PrismaClient) {
  console.log('Creating in house mechanics linked to welinc-auth users...');
  const people = MANIFEST_PEOPLE.filter((p) => {
    const role = vrmsRole(p);
    return role !== null && MECHANIC_ROLES.has(role);
  });
  await prisma.mechanic.createMany({
    data: people.map((p) => ({
      authUserId: p.id,
      email: p.email.toLowerCase(),
      name: p.name,
      role: vrmsRole(p),
      isActive: !INACTIVE_STATES.has(p.state),
    })),
  });
  const inactive = people.filter((p) => INACTIVE_STATES.has(p.state)).length;
  console.log(
    `  ${people.length} in house mechanics created (${inactive} inactive).\n`,
  );
}
