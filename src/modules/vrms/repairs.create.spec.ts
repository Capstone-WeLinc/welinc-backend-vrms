import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma.service';
import { FakeSettings } from '../../settings/settings.fake';
import { FakeEmbeddings } from '../ai/embedding.fake';
import type { CreateRepairDto } from './dto/create-repair.dto';
import { RepairsService } from './repairs.service';
import { driverForLicense } from './ticket-inputs';

// Spec 0016, AC-2 and AC-6: the retry on a repair number clash and the driver insert race.

const known = (meta: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta,
  });

const numberClash = () => known({ target: ['repair_number'] });

const dto = {
  vehiclePlate: 'ABC 123',
  garageLocation: 'Sta. Rosa',
  driverId: '00000000-0000-4000-8000-0000000000d1',
  accountType: 'ONLINE',
  odometerReading: 1000,
  priority: 'LOW',
  issues: [{ categoryId: 'cat1', rootCause: 'Wear', description: 'grinding' }],
} as unknown as CreateRepairDto;

const user = { sub: 'u1', email: 'a@b.c', name: 'Admin' } as never;
const ability = {} as never;

function setup() {
  const prisma = {
    vehicle: { findFirst: jest.fn().mockResolvedValue({ id: 'v1' }) },
    garage: { findFirst: jest.fn().mockResolvedValue({ id: 'g1' }) },
    issueCategory: {
      findMany: jest.fn().mockResolvedValue([{ id: 'cat1', name: 'Brakes' }]),
    },
    knowledgeEntry: { findMany: jest.fn().mockResolvedValue([]) },
    driver: {
      findFirst: jest.fn().mockResolvedValue({ id: 'd1' }),
      findUnique: jest.fn(),
    },
    mechanic: { count: jest.fn() },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn({})),
  };
  const service = new RepairsService(
    prisma as unknown as PrismaService,
    new FakeSettings(),
    new FakeEmbeddings().asService(),
  );
  const internals = service as unknown as {
    createLocked: jest.Mock;
    present: jest.Mock;
    driverFor: (tx: unknown, input: object) => Promise<string>;
  };
  internals.present = jest.fn().mockResolvedValue({ ok: true });
  return { prisma, service, internals };
}

const row = (repairNumber: string) => ({
  repairNumber,
  issues: [{ id: 'i1' }],
});

describe('RepairsService.create repair number clash (AC-2)', () => {
  it('retries once with a new number and succeeds', async () => {
    const { service, internals } = setup();
    internals.createLocked = jest
      .fn()
      .mockRejectedValueOnce(numberClash())
      .mockImplementationOnce((_tx, input: { repairNumber: string }) =>
        Promise.resolve(row(input.repairNumber)),
      );

    await expect(service.create(dto, user, ability)).resolves.toEqual({
      ok: true,
    });

    expect(internals.createLocked).toHaveBeenCalledTimes(2);
    const numbers = internals.createLocked.mock.calls.map(
      (call: [unknown, { repairNumber: string }]) => call[1].repairNumber,
    );
    expect(numbers[0]).not.toBe(numbers[1]);
  });

  it('answers 500 after a second clash', async () => {
    const { service, internals } = setup();
    internals.createLocked = jest.fn().mockRejectedValue(numberClash());

    await expect(service.create(dto, user, ability)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(internals.createLocked).toHaveBeenCalledTimes(2);
  });

  it('does not retry a number the caller chose', async () => {
    const { service, internals } = setup();
    internals.createLocked = jest.fn().mockRejectedValue(numberClash());

    await expect(
      service.create({ ...dto, repairNumber: 'REP-FIXED' }, user, ability),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(internals.createLocked).toHaveBeenCalledTimes(1);
  });

  it('lets any other error through on the first try, without a retry', async () => {
    const { service, internals } = setup();
    const boom = new Error('connection lost');
    internals.createLocked = jest.fn().mockRejectedValue(boom);

    await expect(service.create(dto, user, ability)).rejects.toBe(boom);
    expect(internals.createLocked).toHaveBeenCalledTimes(1);
  });

  it('does not treat a clash on another column as a number clash', async () => {
    const { service, internals } = setup();
    const other = known({ target: ['license_number'] });
    internals.createLocked = jest.fn().mockRejectedValue(other);

    await expect(service.create(dto, user, ability)).rejects.toBe(other);
    expect(internals.createLocked).toHaveBeenCalledTimes(1);
  });
});

describe('driverForLicense insert race (spec 0016, AC-6)', () => {
  const input = { name: 'Pedro', licenseNumber: 'A01-23-456789' };
  const race = (tx: unknown, outside: unknown) =>
    driverForLicense(
      tx as Parameters<typeof driverForLicense>[0],
      outside as Parameters<typeof driverForLicense>[1],
      input,
    );

  it('answers 409 DRIVER_EXISTS with the driver that won the unique index', async () => {
    const { prisma } = setup();
    const tx = {
      driver: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockRejectedValue(known({ target: ['license_number'] })),
      },
    };
    prisma.driver.findUnique.mockResolvedValue({ id: 'd9', name: 'Winner' });

    const error = await race(tx, prisma).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'DRIVER_EXISTS',
      driver: { id: 'd9', name: 'Winner' },
    });
  });

  it('creates an unverified driver when nobody holds the license', async () => {
    const { prisma } = setup();
    const tx = {
      driver: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'd2' }),
      },
    };

    await expect(race(tx, prisma)).resolves.toEqual({ id: 'd2' });
    expect(tx.driver.create).toHaveBeenCalledWith({
      data: { ...input, isVerified: false },
    });
  });

  it('lets an unrelated insert error through', async () => {
    const { prisma } = setup();
    const boom = new Error('disk full');
    const tx = {
      driver: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(boom),
      },
    };

    await expect(race(tx, prisma)).rejects.toBe(boom);
  });
});
