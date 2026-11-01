import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import { ConfigService } from './config.service';

// Spec 0016, AC-11 and AC-14: the vehicle summary and the mechanic open counts.

describe('ConfigService.listAvailableMechanics', () => {
  it('counts open assignments and flags a mechanic with one In Progress', async () => {
    const prisma = {
      mechanic: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'm1',
            name: 'Ana',
            authUserId: 'u1',
            email: 'a@x.com',
            assignments: [
              { repairTicket: { repairStatus: 'ASSIGNED' } },
              { repairTicket: { repairStatus: 'IN_PROGRESS' } },
            ],
          },
          {
            id: 'm2',
            name: 'Ben',
            authUserId: 'u2',
            email: 'b@x.com',
            assignments: [],
          },
        ]),
      },
    };
    const service = new ConfigService(prisma as unknown as PrismaService);
    const rows = await service.listAvailableMechanics();
    expect(rows[0]).toMatchObject({
      openCount: 2,
      busy: true,
      isAvailable: false,
    });
    expect(rows[1]).toMatchObject({
      openCount: 0,
      busy: false,
      isAvailable: true,
    });
  });
});

describe('ConfigService.vehicleSummary', () => {
  const vehicle = {
    id: 'v1',
    plateNumber: 'ABC1234',
    model: 'Isuzu',
    status: 'AVAILABLE',
    vehicleType: { id: 't1', name: '6 wheeler' },
  };
  function setup(over: { vehicle?: unknown; driver?: unknown } = {}) {
    const prisma = {
      vehicle: {
        findFirst: jest
          .fn()
          .mockResolvedValue('vehicle' in over ? over.vehicle : vehicle),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ odometer: 100 }),
      },
      repairTicket: {
        aggregate: jest
          .fn()
          .mockResolvedValueOnce({ _max: { odometer: 5000 } })
          .mockResolvedValueOnce({
            _max: { closedAt: new Date('2026-10-01') },
          }),
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ driver: over.driver })
          .mockResolvedValueOnce(null),
      },
    };
    return new ConfigService(prisma as unknown as PrismaService);
  }

  it('answers 404 for an unknown or inactive truck', async () => {
    await expect(
      setup({ vehicle: null }).vehicleSummary('v1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the facts with the last driver when still active', async () => {
    const driver = {
      id: 'd1',
      name: 'Ana',
      licenseNumber: 'A01-23-456789',
      isActive: true,
      deletedAt: null,
    };
    const out = await setup({ driver }).vehicleSummary('v1');
    expect(out.lastOdometer).toBe(5000);
    expect(out.lastDriver).toEqual({
      id: 'd1',
      name: 'Ana',
      licenseNumber: 'A01-23-456789',
    });
    expect(out.openTicket).toBeNull();
    expect(out.type).toEqual({ id: 't1', name: '6 wheeler' });
  });

  it('drops the last driver when they are now inactive', async () => {
    const driver = {
      id: 'd1',
      name: 'Ana',
      licenseNumber: 'x',
      isActive: false,
      deletedAt: null,
    };
    expect(
      (await setup({ driver }).vehicleSummary('v1')).lastDriver,
    ).toBeNull();
  });
});
