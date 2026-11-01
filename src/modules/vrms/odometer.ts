import { BadRequestException } from '@nestjs/common';
import { Prisma, RepairStatus } from '@prisma/client';

// Spec 0016, AC-7: the odometer floor and jump rules for a new ticket.

type Reader = Pick<Prisma.TransactionClient, 'repairTicket' | 'vehicle'>;

/**
 * The lowest reading a new ticket may carry: the highest odometer on the truck's non cancelled
 * tickets whenever it has any, and the vehicle's own reading only when it has none. The create
 * check and the vehicle summary both read it here.
 */
export async function vehicleOdometerFloor(
  db: Reader,
  vehicleId: string,
): Promise<number> {
  const top = await db.repairTicket.aggregate({
    _max: { odometer: true },
    where: { vehicleId, repairStatus: { not: RepairStatus.CANCELLED } },
  });
  if (top._max.odometer !== null) return top._max.odometer;
  const vehicle = await db.vehicle.findUniqueOrThrow({
    where: { id: vehicleId },
    select: { odometer: true },
  });
  return vehicle.odometer;
}

/** The 400 for a reading below the floor or a big jump nobody confirmed; null when it is fine. */
export function odometerProblem(
  reading: number,
  floor: number,
  jumpWarnKm: number,
  confirmed: boolean,
): BadRequestException | null {
  if (reading < floor) {
    return new BadRequestException({
      statusCode: 400,
      code: 'ODOMETER_BELOW_LAST',
      message: `Odometer can't be lower than the last reading, ${floor.toLocaleString('en-US')} km.`,
      last: floor,
    });
  }
  // No baseline yet (floor 0): nothing to jump from
  if (floor > 0 && reading - floor > jumpWarnKm && !confirmed) {
    return new BadRequestException({
      statusCode: 400,
      code: 'ODOMETER_JUMP_UNCONFIRMED',
      message: `This reading is ${(reading - floor).toLocaleString('en-US')} km above the last one, ${floor.toLocaleString('en-US')} km. Confirm it is right.`,
      last: floor,
    });
  }
  return null;
}
