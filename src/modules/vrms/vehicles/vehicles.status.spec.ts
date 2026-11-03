import { ConflictException, NotFoundException } from '@nestjs/common';
import { UserRole } from '../../../auth/roles';
import { PrismaService } from '../../../shared/prisma.service';
import { VehiclesService } from './vehicles.service';

// Spec 0020, AC-1 to AC-5a: the Admin status toggle.

const admin = {
  sub: '00000000-0000-4000-8000-000000000002',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS' as const,
};

const LOADED = new Date('2026-11-01T01:00:00.000Z');
const AT = LOADED.toISOString();

function setup(
  over: {
    vehicle?: unknown;
    locked?: { status: string; updated_at: Date }[];
    open?: { id: string; repairNumber: string } | null;
  } = {},
) {
  const order: string[] = [];
  const row = {
    id: 'v1',
    plateNumber: 'ABC 123',
    model: 'Isuzu',
    status: 'DISABLED',
    updatedAt: LOADED,
    vehicleType: null,
    repairTickets: [],
  };
  const tx = {
    $queryRaw: jest.fn(() => {
      order.push('lock');
      return Promise.resolve(
        over.locked ?? [{ status: 'AVAILABLE', updated_at: LOADED }],
      );
    }),
    repairTicket: {
      findFirst: jest.fn(() => {
        order.push('open');
        return Promise.resolve(over.open ?? null);
      }),
    },
    vehicle: {
      update: jest.fn().mockResolvedValue({}),
      findUniqueOrThrow: jest.fn().mockResolvedValue(row),
    },
    vehicleChange: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    vehicle: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          'vehicle' in over ? over.vehicle : { updatedAt: LOADED },
        ),
    },
    $transaction: jest.fn((run: (c: typeof tx) => unknown) => run(tx)),
  };
  return {
    tx,
    order,
    service: new VehiclesService(prisma as unknown as PrismaService),
  };
}

const DISABLE = {
  status: 'DISABLED' as const,
  reason: 'Engine seized',
  updatedAt: AT,
};

async function failure(run: Promise<unknown>) {
  try {
    await run;
  } catch (err: unknown) {
    const body = (err as ConflictException).getResponse() as {
      code?: string;
    };
    return { err, code: body.code };
  }
  throw new Error('expected a rejection');
}

describe('VehiclesService.setStatus', () => {
  it('disables an Available truck and writes one status row with the reason', async () => {
    const { service, tx } = setup();
    const out = await service.setStatus('v1', DISABLE, admin);
    expect(out.status).toBe('DISABLED');
    expect(tx.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { status: 'DISABLED' },
    });
    expect(tx.vehicleChange.create).toHaveBeenCalledTimes(1);
    expect(tx.vehicleChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        vehicleId: 'v1',
        field: 'status',
        before: 'AVAILABLE',
        after: 'DISABLED',
        note: 'Engine seized',
        repairTicketId: null,
        actorUserId: admin.sub,
        actorName: 'Victor Ramos',
        actorEmail: admin.email,
      }) as unknown,
    });
  });

  it('makes a stuck Under repair truck with no open ticket available', async () => {
    const { service, tx } = setup({
      locked: [{ status: 'UNDER_REPAIR', updated_at: LOADED }],
    });
    await service.setStatus('v1', { ...DISABLE, status: 'AVAILABLE' }, admin);
    expect(tx.vehicleChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        before: 'UNDER_REPAIR',
        after: 'AVAILABLE',
      }) as unknown,
    });
  });

  it('answers 404 for an unknown truck before anything else', async () => {
    const { service, tx } = setup({ vehicle: null });
    await expect(
      service.setStatus(
        'v1',
        { ...DISABLE, updatedAt: '2020-01-01T00:00:00.000Z' },
        admin,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('answers STALE_VEHICLE before the transaction and again under the lock', async () => {
    const early = setup();
    const first = await failure(
      early.service.setStatus(
        'v1',
        { ...DISABLE, updatedAt: '2026-01-01T00:00:00.000Z' },
        admin,
      ),
    );
    expect(first.code).toBe('STALE_VEHICLE');
    expect(early.tx.$queryRaw).not.toHaveBeenCalled();

    const late = setup({
      locked: [
        { status: 'AVAILABLE', updated_at: new Date('2026-11-02T00:00:00Z') },
      ],
    });
    const second = await failure(late.service.setStatus('v1', DISABLE, admin));
    expect(second.code).toBe('STALE_VEHICLE');
    expect(late.tx.repairTicket.findFirst).not.toHaveBeenCalled();
  });

  it('refuses an Under maintenance truck before the open ticket check', async () => {
    const { service, tx } = setup({
      locked: [{ status: 'UNDER_MAINTENANCE', updated_at: LOADED }],
      open: { id: 't1', repairNumber: 'R-0123' },
    });
    const { code } = await failure(service.setStatus('v1', DISABLE, admin));
    expect(code).toBe('VEHICLE_STATUS_LOCKED');
    expect(tx.repairTicket.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a truck with an open ticket, after the lock, naming the ticket', async () => {
    const { service, tx, order } = setup({
      open: { id: 't1', repairNumber: 'R-0123' },
    });
    const { err, code } = await failure(
      service.setStatus('v1', DISABLE, admin),
    );
    expect(code).toBe('OPEN_TICKET_EXISTS');
    expect((err as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      code: 'OPEN_TICKET_EXISTS',
      message:
        'This truck has an open repair, R-0123. Change its status after the repair is closed or cancelled.',
      ticket: { id: 't1', repairNumber: 'R-0123' },
    });
    expect(order).toEqual(['lock', 'open']);
    expect(tx.vehicle.update).not.toHaveBeenCalled();
  });

  it('answers STALE_VEHICLE when the target equals the current status, after the open ticket check', async () => {
    const { service, tx, order } = setup({
      locked: [{ status: 'DISABLED', updated_at: LOADED }],
    });
    const { code } = await failure(service.setStatus('v1', DISABLE, admin));
    expect(code).toBe('STALE_VEHICLE');
    expect(order).toEqual(['lock', 'open']);
    expect(tx.vehicleChange.create).not.toHaveBeenCalled();
  });
});
