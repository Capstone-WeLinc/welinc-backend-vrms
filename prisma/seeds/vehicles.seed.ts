import { PrismaClient, VehicleStatus } from '@prisma/client';

export async function seedVehicles(prisma: PrismaClient) {
  console.log('Creating sample vehicles...');

  const vehiclesData = [
    {
      plateNumber: 'NDG 5821',
      model: 'Isuzu Elf NKR',
      status: VehicleStatus.AVAILABLE,
      odometer: 45000,
    },
    {
      plateNumber: 'CAK 9043',
      model: 'Mitsubishi Fuso FE',
      status: VehicleStatus.AVAILABLE,
      odometer: 72000,
    },
    {
      plateNumber: 'WOB 2947',
      model: 'Hino 300 Series',
      status: VehicleStatus.AVAILABLE,
      odometer: 31500,
    },
    {
      plateNumber: 'PXW 382',
      model: 'Toyota Hilux',
      status: VehicleStatus.AVAILABLE,
      odometer: 18000,
    },
    {
      plateNumber: 'TGD 908',
      model: 'Foton Tornado',
      status: VehicleStatus.AVAILABLE,
      odometer: 92000,
    },
    {
      plateNumber: 'NRE 471',
      model: 'Isuzu Giga',
      status: VehicleStatus.AVAILABLE,
      odometer: 145000,
    },
  ];

  const vehicles = await Promise.all(
    vehiclesData.map((v) =>
      prisma.vehicle.upsert({
        where: { plateNumber: v.plateNumber },
        update: {},
        create: v,
      }),
    ),
  );

  console.log(`  Created ${vehicles.length} sample vehicles\n`);
  return vehicles;
}
