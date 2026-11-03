import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '../../../auth/roles';
import { PrismaService } from '../../../shared/prisma.service';
import { VehiclesService } from './vehicles.service';

// Spec 0016, AC-21: setting a truck's type.

const admin = {
  sub: '00000000-0000-4000-8000-000000000002',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS' as const,
};
const LOADED = new Date('2026-11-01T01:00:00.000Z');
const AT = LOADED.toISOString();
const TYPE = '00000000-0000-4000-8000-0000000000c1';
const SIX = { id: TYPE, name: '6 wheeler' };

function setup(
  over: { vehicle?: unknown; type?: unknown; count?: number } = {},
) {
  const row = {
    id: 'v1',
    plateNumber: 'ABC 123',
    model: 'Isuzu',
    status: 'AVAILABLE',
    updatedAt: LOADED,
    vehicleType: null,
    repairTickets: [],
  };
  const tx = {
    vehicle: {
      updateMany: jest.fn().mockResolvedValue({ count: over.count ?? 1 }),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ ...row, vehicleType: SIX }),
    },
    vehicleChange: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    vehicle: {
      findFirst: jest
        .fn()
        .mockResolvedValue('vehicle' in over ? over.vehicle : row),
    },
    lookupValue: {
      findFirst: jest.fn().mockResolvedValue('type' in over ? over.type : SIX),
    },
    $transaction: jest.fn((run: (c: typeof tx) => unknown) => run(tx)),
  };
  return {
    tx,
    service: new VehiclesService(prisma as unknown as PrismaService),
  };
}

describe('VehiclesService.update', () => {
  it('sets the type and writes one VehicleChange row with before and after', async () => {
    const { service, tx } = setup();
    const out = await service.update(
      'v1',
      { vehicleTypeId: TYPE, updatedAt: AT },
      admin,
    );
    expect(out.type).toEqual(SIX);
    const change = tx.vehicleChange.create.mock.calls[0] as [
      { data: { field: string; after: unknown } },
    ];
    expect(change[0].data.field).toBe('vehicleType');
    expect(change[0].data.after).toEqual(SIX);
  });

  it('answers 409 on a stale updatedAt, before and inside the transaction', async () => {
    await expect(
      setup().service.update(
        'v1',
        { vehicleTypeId: TYPE, updatedAt: '2026-01-01T00:00:00.000Z' },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      setup({ count: 0 }).service.update(
        'v1',
        { vehicleTypeId: TYPE, updatedAt: AT },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers 400 for an inactive type or one from another list', async () => {
    await expect(
      setup({ type: null }).service.update(
        'v1',
        { vehicleTypeId: TYPE, updatedAt: AT },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 404 for an unknown truck', async () => {
    await expect(
      setup({ vehicle: null }).service.update(
        'v1',
        { vehicleTypeId: null, updatedAt: AT },
        admin,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes nothing when the type is already that one', async () => {
    const { service, tx } = setup();
    await service.update('v1', { vehicleTypeId: null, updatedAt: AT }, admin);
    expect(tx.vehicleChange.create).not.toHaveBeenCalled();
  });
});
