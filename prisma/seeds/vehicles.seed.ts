import { Prisma } from '@prisma/client';
import { VEHICLES } from './catalog';

// Odometer and status start at the beginning of the history; the repairs seed moves them forward
export async function seedVehicles(prisma: Prisma.TransactionClient) {
  console.log('Creating fleet vehicles...');

  // The starting vehicle types come from the migration (spec 0016, AC-20)
  const types = await prisma.lookupValue.findMany({
    where: { list: 'vehicle_type' },
    select: { id: true, name: true },
  });
  const typeId = new Map(types.map((t) => [t.name, t.id]));

  const vehicles = await Promise.all(
    VEHICLES.map((v) => {
      const vehicleTypeId = typeId.get(v.type);
      if (!vehicleTypeId) {
        throw new Error(`Seed: no vehicle type named "${v.type}"`);
      }
      return prisma.vehicle.create({
        data: {
          plateNumber: v.plateNumber,
          model: v.model,
          capacity: v.capacity,
          odometer: v.startKm,
          vehicleTypeId,
        },
      });
    }),
  );

  console.log(`  Created ${vehicles.length} fleet vehicles\n`);
  return vehicles;
}
