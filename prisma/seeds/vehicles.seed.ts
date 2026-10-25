import { PrismaClient } from '@prisma/client';
import { VEHICLES } from './catalog';

// Odometer and status start at the beginning of the history; the repairs seed moves them forward
export async function seedVehicles(prisma: PrismaClient) {
  console.log('Creating fleet vehicles...');

  const vehicles = await Promise.all(
    VEHICLES.map((v) =>
      prisma.vehicle.create({
        data: {
          plateNumber: v.plateNumber,
          model: v.model,
          capacity: v.capacity,
          odometer: v.startKm,
        },
      }),
    ),
  );

  console.log(`  Created ${vehicles.length} fleet vehicles\n`);
  return vehicles;
}
