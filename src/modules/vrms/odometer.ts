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

/** Spec 0019, AC-5: the readings a corrected ticket must sit between. */
export type OdometerBounds = {
  /** The highest reading ordered before this ticket, else the vehicle's own reading. */
  floor: number;
  /** The ticket that holds the floor; null when it is the vehicle's reading. */
  floorTicket: string | null;
  /** The lowest reading ordered after this ticket; null when there is none. */
  ceiling: number | null;
  ceilingTicket: string | null;
};

/**
 * Spec 0019, AC-5: "other tickets" are the truck's non cancelled tickets except this one, ordered
 * by (createdAt, id) so tickets created at the same moment still have an order. Never
 * vehicleOdometerFloor, which counts this ticket too. A closed floor ticket counts like an open one.
 */
export async function ticketOdometerBounds(
  db: Reader,
  ticket: { id: string; vehicleId: string; createdAt: Date },
): Promise<OdometerBounds> {
  const others: Prisma.RepairTicketWhereInput = {
    vehicleId: ticket.vehicleId,
    id: { not: ticket.id },
    repairStatus: { not: RepairStatus.CANCELLED },
  };
  const [before, after] = await Promise.all([
    db.repairTicket.findFirst({
      where: {
        ...others,
        OR: [
          { createdAt: { lt: ticket.createdAt } },
          { createdAt: ticket.createdAt, id: { lt: ticket.id } },
        ],
      },
      orderBy: [{ odometer: 'desc' }, { createdAt: 'desc' }],
      select: { odometer: true, repairNumber: true },
    }),
    db.repairTicket.findFirst({
      where: {
        ...others,
        OR: [
          { createdAt: { gt: ticket.createdAt } },
          { createdAt: ticket.createdAt, id: { gt: ticket.id } },
        ],
      },
      orderBy: [{ odometer: 'asc' }, { createdAt: 'asc' }],
      select: { odometer: true, repairNumber: true },
    }),
  ]);
  const floor =
    before?.odometer ??
    (
      await db.vehicle.findUniqueOrThrow({
        where: { id: ticket.vehicleId },
        select: { odometer: true },
      })
    ).odometer;
  return {
    floor,
    floorTicket: before?.repairNumber ?? null,
    ceiling: after?.odometer ?? null,
    ceilingTicket: after?.repairNumber ?? null,
  };
}

/**
 * Spec 0019, AC-5: the 400 for a corrected reading below the floor, above the ceiling, or a big
 * jump over the floor nobody confirmed; null when it is fine. Both messages name the blocking
 * ticket.
 */
export function correctedOdometerProblem(
  reading: number,
  bounds: OdometerBounds,
  jumpWarnKm: number,
  confirmed: boolean,
): BadRequestException | null {
  const km = (n: number) => `${n.toLocaleString('en-US')} km`;
  if (reading < bounds.floor) {
    return new BadRequestException({
      statusCode: 400,
      code: 'ODOMETER_BELOW_LAST',
      message: bounds.floorTicket
        ? `Odometer can't be lower than ${km(bounds.floor)}, the reading on ${bounds.floorTicket}.`
        : `Odometer can't be lower than the truck's last reading, ${km(bounds.floor)}.`,
      last: bounds.floor,
      repairNumber: bounds.floorTicket,
    });
  }
  if (bounds.ceiling !== null && reading > bounds.ceiling) {
    return new BadRequestException({
      statusCode: 400,
      code: 'ODOMETER_ABOVE_NEXT',
      message: `Odometer can't be higher than ${km(bounds.ceiling)}, the reading on the later ticket ${bounds.ceilingTicket}.`,
      next: bounds.ceiling,
      repairNumber: bounds.ceilingTicket,
    });
  }
  // The jump rule, against the floor, as on create
  const jump = odometerProblem(reading, bounds.floor, jumpWarnKm, confirmed);
  return jump;
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
