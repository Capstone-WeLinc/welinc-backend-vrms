import { PrismaClient, VehicleStatus } from '@prisma/client';

export async function seedVehicles(prisma: PrismaClient) {
  console.log('Creating sample fleet vehicles...');

  const vehiclesData = [
    { plateNumber: 'NDG 5821', model: 'Isuzu Elf NKR', status: VehicleStatus.AVAILABLE, odometer: 45000 },
    { plateNumber: 'CAK 9043', model: 'Mitsubishi Fuso FE', status: VehicleStatus.AVAILABLE, odometer: 72000 },
    { plateNumber: 'WOB 2947', model: 'Hino 300 Series', status: VehicleStatus.AVAILABLE, odometer: 31500 },
    { plateNumber: 'PXW 382', model: 'Toyota Hilux', status: VehicleStatus.AVAILABLE, odometer: 18000 },
    { plateNumber: 'TGD 908', model: 'Foton Tornado', status: VehicleStatus.AVAILABLE, odometer: 92000 },
    { plateNumber: 'NRE 471', model: 'Isuzu Giga', status: VehicleStatus.AVAILABLE, odometer: 145000 },
    { plateNumber: 'ABC 1234', model: 'Hyundai Mighty EX8', status: VehicleStatus.AVAILABLE, odometer: 52000 },
    { plateNumber: 'XYZ 5678', model: 'Fuso Canter TF', status: VehicleStatus.AVAILABLE, odometer: 63000 },
    { plateNumber: 'KLM 9101', model: 'Isuzu Forward FVR', status: VehicleStatus.AVAILABLE, odometer: 110000 },
    { plateNumber: 'QWE 3456', model: 'Hino 500 Series', status: VehicleStatus.AVAILABLE, odometer: 88000 },
    { plateNumber: 'RTY 7890', model: 'UD Trucks Croner', status: VehicleStatus.AVAILABLE, odometer: 41000 },
    { plateNumber: 'UIO 2345', model: 'Dongfeng Captain E', status: VehicleStatus.AVAILABLE, odometer: 67000 },
    { plateNumber: 'PAS 6789', model: 'MAN TGM Heavy', status: VehicleStatus.AVAILABLE, odometer: 135000 },
    { plateNumber: 'DFG 1122', model: 'Volvo FL Rigid', status: VehicleStatus.AVAILABLE, odometer: 98000 },
    { plateNumber: 'HJK 3344', model: 'Scania P-Series', status: VehicleStatus.AVAILABLE, odometer: 155000 },
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

  console.log(`  Created ${vehicles.length} fleet vehicles\n`);
  return vehicles;
}
