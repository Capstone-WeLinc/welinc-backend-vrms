import { PrismaClient } from '@prisma/client';

export async function seedGarages(prisma: PrismaClient) {
  console.log('Creating garages...');

  const garages = await Promise.all([
    prisma.garage.upsert({
      where: { name: 'Sta. Rosa' },
      update: {},
      create: { name: 'Sta. Rosa' },
    }),
    prisma.garage.upsert({
      where: { name: 'Marikina' },
      update: {},
      create: { name: 'Marikina' },
    }),
    prisma.garage.upsert({
      where: { name: 'Pulilan' },
      update: {},
      create: { name: 'Pulilan' },
    }),
  ]);

  console.log(
    `  Created ${garages.length} garages: ${garages.map((g) => g.name).join(', ')}\n`,
  );
  return garages;
}
