import { BadRequestException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import {
  correctedOdometerProblem,
  odometerProblem,
  ticketOdometerBounds,
  vehicleOdometerFloor,
} from './odometer';

// Spec 0016, AC-7: the floor and the jump rule.

function reader(maxOdometer: number | null, vehicleOdometer = 0) {
  return {
    repairTicket: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _max: { odometer: maxOdometer } }),
    },
    vehicle: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ odometer: vehicleOdometer }),
    },
  };
}

const bodyOf = (error: BadRequestException | null) =>
  error?.getResponse() as { code: string; last: number; message: string };

describe('vehicleOdometerFloor', () => {
  it('is the highest reading on the truck tickets, whatever the vehicle says (AC-7)', async () => {
    const db = reader(45210, 90000);
    await expect(vehicleOdometerFloor(db as never, 'v1')).resolves.toBe(45210);
    expect(db.vehicle.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('leaves cancelled tickets out of the maximum', async () => {
    const db = reader(1000);
    await vehicleOdometerFloor(db as never, 'v1');
    expect(db.repairTicket.aggregate).toHaveBeenCalledWith({
      _max: { odometer: true },
      where: { vehicleId: 'v1', repairStatus: { not: RepairStatus.CANCELLED } },
    });
  });

  it('falls back to the vehicle reading only when the truck has no tickets', async () => {
    const db = reader(null, 5000);
    await expect(vehicleOdometerFloor(db as never, 'v1')).resolves.toBe(5000);
  });

  it('keeps a stored 0 ticket reading as the floor instead of falling back', async () => {
    const db = reader(0, 5000);
    await expect(vehicleOdometerFloor(db as never, 'v1')).resolves.toBe(0);
  });
});

describe('odometerProblem', () => {
  it('accepts a reading equal to the floor', () => {
    expect(odometerProblem(1000, 1000, 20000, false)).toBeNull();
  });

  it('refuses a reading below the floor and names it with a thousands separator', () => {
    const error = odometerProblem(44000, 45210, 20000, false);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(bodyOf(error)).toMatchObject({
      code: 'ODOMETER_BELOW_LAST',
      last: 45210,
    });
    expect(bodyOf(error).message).toContain('45,210 km');
  });

  it('refuses below the floor even when the jump is confirmed', () => {
    expect(bodyOf(odometerProblem(1, 1000, 20000, true)).code).toBe(
      'ODOMETER_BELOW_LAST',
    );
  });

  it('accepts a rise of exactly the warn distance, and asks above it', () => {
    expect(odometerProblem(21000, 1000, 20000, false)).toBeNull();
    expect(bodyOf(odometerProblem(21001, 1000, 20000, false)).code).toBe(
      'ODOMETER_JUMP_UNCONFIRMED',
    );
  });

  it('passes a big jump once the engineer confirms it', () => {
    expect(odometerProblem(90000, 1000, 20000, true)).toBeNull();
  });

  it('never asks about a jump when the floor is 0 (no baseline)', () => {
    expect(odometerProblem(900000, 0, 20000, false)).toBeNull();
  });
});

// Spec 0019, AC-5: the readings a corrected ticket must sit between.
describe('ticketOdometerBounds', () => {
  const ticket = {
    id: 't2',
    vehicleId: 'v1',
    createdAt: new Date('2026-11-01'),
  };

  function boundsReader(
    before: { odometer: number; repairNumber: string } | null,
    after: { odometer: number; repairNumber: string } | null,
  ) {
    return {
      repairTicket: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(before)
          .mockResolvedValueOnce(after),
      },
      // Never read: the vehicle's own reading is the truck's latest, so it is no floor here
      vehicle: { findUniqueOrThrow: jest.fn() },
    };
  }

  it('takes the floor and the ceiling from the neighbouring tickets', async () => {
    const db = boundsReader(
      { odometer: 1000, repairNumber: 'REP-1' },
      { odometer: 2000, repairNumber: 'REP-3' },
    );
    expect(await ticketOdometerBounds(db as never, ticket)).toEqual({
      floor: 1000,
      floorTicket: 'REP-1',
      ceiling: 2000,
      ceilingTicket: 'REP-3',
    });
  });

  it('has no floor with no earlier ticket, and does not read the vehicle', async () => {
    const db = boundsReader(null, { odometer: 2000, repairNumber: 'REP-3' });
    expect(await ticketOdometerBounds(db as never, ticket)).toEqual({
      floor: null,
      floorTicket: null,
      ceiling: 2000,
      ceilingTicket: 'REP-3',
    });
    expect(db.vehicle.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('correctedOdometerProblem', () => {
  const none = {
    floor: null,
    floorTicket: null,
    ceiling: null,
    ceilingTicket: null,
  };

  it('allows any reading, and never asks about a jump, when there is no floor', () => {
    expect(correctedOdometerProblem(0, none, 20000, false)).toBeNull();
    expect(correctedOdometerProblem(900000, none, 20000, false)).toBeNull();
  });

  it('still refuses a reading above the ceiling when there is no floor', () => {
    const error = correctedOdometerProblem(
      3000,
      { ...none, ceiling: 2000, ceilingTicket: 'REP-3' },
      20000,
      false,
    );
    expect((error?.getResponse() as { code: string }).code).toBe(
      'ODOMETER_ABOVE_NEXT',
    );
  });

  it('names the floor ticket below the floor, and asks about a big jump above it', () => {
    const bounds = { ...none, floor: 1000, floorTicket: 'REP-1' };
    const below = correctedOdometerProblem(500, bounds, 20000, false);
    expect(below?.getResponse()).toMatchObject({
      code: 'ODOMETER_BELOW_LAST',
      repairNumber: 'REP-1',
    });
    const jump = correctedOdometerProblem(90000, bounds, 20000, false);
    expect((jump?.getResponse() as { code: string }).code).toBe(
      'ODOMETER_JUMP_UNCONFIRMED',
    );
  });
});
