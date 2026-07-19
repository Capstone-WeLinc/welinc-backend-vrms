import { PrismaClient } from '@prisma/client';

export async function seedDrivers(prisma: PrismaClient) {
  console.log('Creating sample drivers...');

  const driversData = [
    {
      name: 'Danilo Ramos',
      licenseNumber: 'N01-12-894721',
      isVerified: true,
      isActive: true,
    },
    {
      name: 'Edgardo Santos',
      licenseNumber: 'D18-09-247913',
      isVerified: false,
      isActive: true,
    },
    {
      name: 'Ramon dela Cruz',
      licenseNumber: 'N22-15-683921',
      isVerified: true,
      isActive: true,
    },
    {
      name: 'Arnel Gonzales',
      licenseNumber: 'D02-14-572948',
      isVerified: true,
      isActive: true,
    },
    {
      name: 'Bernardo Reyes',
      licenseNumber: 'N15-18-934721',
      isVerified: true,
      isActive: true,
    },
    {
      name: 'Catalino Castro',
      licenseNumber: 'D04-20-472198',
      isVerified: false,
      isActive: true,
    },
    {
      name: 'Dionisio Bulaon',
      licenseNumber: 'N08-11-237498',
      isVerified: true,
      isActive: true,
    },
  ];

  const drivers = await Promise.all(
    driversData.map((d) =>
      prisma.driver.upsert({
        where: { licenseNumber: d.licenseNumber },
        update: {},
        create: d,
      }),
    ),
  );

  console.log(`  Created ${drivers.length} sample drivers\n`);
  return drivers;
}
