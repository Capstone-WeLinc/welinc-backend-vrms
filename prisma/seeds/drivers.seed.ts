import { PrismaClient } from '@prisma/client';
import { DRIVERS } from './catalog';
import { DAY } from './random';

export async function seedDrivers(prisma: PrismaClient, now: number) {
  console.log('Creating drivers...');

  const drivers = await Promise.all(
    DRIVERS.map((d) => {
      const left = d.leftMonthsAgo
        ? new Date(now - d.leftMonthsAgo * 30 * DAY)
        : null;
      return prisma.driver.create({
        data: {
          name: d.name,
          licenseNumber: d.licenseNumber,
          isVerified: d.isVerified,
          isActive: !left,
          deletedAt: left,
        },
      });
    }),
  );

  console.log(`  Created ${drivers.length} drivers\n`);
  return drivers;
}
