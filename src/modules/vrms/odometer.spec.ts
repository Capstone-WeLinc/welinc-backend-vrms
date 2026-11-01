import { BadRequestException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { odometerProblem, vehicleOdometerFloor } from './odometer';

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
