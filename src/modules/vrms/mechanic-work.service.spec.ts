import { ConflictException, NotFoundException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import type { AuthUser } from '../../auth/account-check';
import { MechanicRoster } from './mechanic-roster.service';
import { leaveReason, MechanicWorkService } from './mechanic-work.service';
import { permanentRoles } from './directory/auth-directory.client';

// Spec 0011, AC-32 and AC-33: open work and release, against an in memory ticket list.
// Spec 0014, AC-1: the release to Open goes through applyStatusMove with its one audit row.

const LOADED = new Date('2026-10-29T01:00:00.000Z');

type Ticket = {
  id: string;
  repairStatus: RepairStatus;
  others: number; // assignments besides the leaver's
  mine: boolean;
};

const admin = {
  sub: 'admin',
  email: 'admin@welinc.com',
  name: 'Admin',
  system: 'VRMS',
  roles: [{ role: 'ADMIN', system: 'VRMS' }],
} as unknown as AuthUser;

function setup(
  tickets: Ticket[],
  refresh: { mechanicId: string; stillActive: boolean } | null,
) {
  const audits: { repairTicketId: string; action: string; note: string }[] = [];
  const tx = {
    mechanic: {
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({ id: 'm1', name: 'Leaver' }),
      ),
    },
    repairTicket: {
      findMany: jest.fn(() =>
        Promise.resolve(
          tickets
            .filter(
              (t) =>
                t.mine &&
                (
                  [
                    RepairStatus.OPEN,
                    RepairStatus.ASSIGNED,
                    RepairStatus.IN_PROGRESS,
                    RepairStatus.ON_HOLD,
                  ] as RepairStatus[]
                ).includes(t.repairStatus),
            )
            .map((t) => ({
              id: t.id,
              repairStatus: t.repairStatus,
              updatedAt: LOADED,
              vehicleId: 'v1',
              odometer: 1000,
              _count: { assignments: t.others + 1 },
            })),
        ),
      ),
      // The M2 release goes through applyStatusMove's conditional update
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: { repairStatus: RepairStatus };
        }) => {
          tickets.find((x) => x.id === where.id)!.repairStatus =
            data.repairStatus;
          return Promise.resolve({ count: 1 });
        },
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: { repairStatus?: RepairStatus };
        }) => {
          const t = tickets.find((x) => x.id === where.id)!;
          if (data.repairStatus) t.repairStatus = data.repairStatus;
          return Promise.resolve({});
        },
      ),
    },
    ticketAssignment: {
      deleteMany: jest.fn(
        ({ where }: { where: { repairTicketId: string } }) => {
          const t = tickets.find((x) => x.id === where.repairTicketId)!;
          const count = t.mine ? 1 : 0;
          t.mine = false;
          return Promise.resolve({ count });
        },
      ),
    },
    auditLog: {
      create: jest.fn(({ data }: { data: (typeof audits)[number] }) => {
        audits.push(data);
        return Promise.resolve({});
      }),
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx)),
  } as unknown as PrismaService;
  const roster = {
    refreshOne: jest.fn(() => Promise.resolve(refresh)),
  } as unknown as MechanicRoster;
  return { service: new MechanicWorkService(prisma, roster), audits };
}

describe('MechanicWorkService.release', () => {
  it('moves an ASSIGNED ticket back to OPEN, keeps IN_PROGRESS, and a second call releases nothing', async () => {
    const tickets: Ticket[] = [
      { id: 't1', repairStatus: RepairStatus.ASSIGNED, others: 0, mine: true },
      {
        id: 't2',
        repairStatus: RepairStatus.IN_PROGRESS,
        others: 0,
        mine: true,
      },
      {
        id: 't3',
        repairStatus: RepairStatus.FOR_VERIFICATION,
        others: 0,
        mine: true,
      },
    ];
    const { service, audits } = setup(tickets, {
      mechanicId: 'm1',
      stillActive: false,
    });

    expect(await service.release('u1', 'DEACTIVATED', admin)).toEqual({
      released: 2,
      reopened: 1,
    });
    expect(tickets.map((t) => t.repairStatus)).toEqual([
      RepairStatus.OPEN,
      RepairStatus.IN_PROGRESS,
      RepairStatus.FOR_VERIFICATION,
    ]);
    // One row per released ticket; the reopened one records its status change in the same row
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: 'MECHANIC_UNASSIGNED',
      note: 'Account deactivated',
      changes: [
        { field: 'mechanic', before: 'Leaver', after: null },
        { field: 'repairStatus', before: 'ASSIGNED', after: 'OPEN' },
      ],
    });

    expect(await service.release('u1', 'DEACTIVATED', admin)).toEqual({
      released: 0,
      reopened: 0,
    });
  });

  it('keeps an ASSIGNED ticket assigned while another mechanic is on it', async () => {
    const tickets: Ticket[] = [
      { id: 't1', repairStatus: RepairStatus.ASSIGNED, others: 1, mine: true },
    ];
    const { service } = setup(tickets, {
      mechanicId: 'm1',
      stillActive: false,
    });
    expect(await service.release('u1', 'ROLE_REMOVED', admin)).toEqual({
      released: 1,
      reopened: 0,
    });
    expect(tickets[0].repairStatus).toBe(RepairStatus.ASSIGNED);
  });

  it('answers 409 while the person is still an active mechanic and 404 with no row', async () => {
    const active = setup([], { mechanicId: 'm1', stillActive: true });
    await expect(
      active.service.release('u1', 'DEACTIVATED', admin),
    ).rejects.toThrow(ConflictException);
    const none = setup([], null);
    await expect(
      none.service.release('u1', 'DEACTIVATED', admin),
    ).rejects.toThrow(NotFoundException);
  });
});

// Suite spec 0013, AC-11
describe('temporary roles', () => {
  const person = {
    id: 'a',
    name: 'A',
    email: 'a@welinc.com',
    phone: null,
    picture: null,
    isActive: true,
    deleted: false,
    erased: false,
    updatedAt: '2026-11-13T00:00:00.000Z',
  };

  it('leaves temporary codes out, and reads a missing list as none', () => {
    expect(
      permanentRoles({
        roles: ['ADMIN', 'MECHANIC'],
        temporaryRoles: ['ADMIN'],
      }),
    ).toEqual(['MECHANIC']);
    expect(permanentRoles({ roles: ['MECHANIC'] })).toEqual(['MECHANIC']);
  });

  it('counts only a permanent Mechanic or Chief Mechanic role as still working', () => {
    expect(
      leaveReason({
        ...person,
        roles: ['MECHANIC'],
        temporaryRoles: ['MECHANIC'],
      }),
    ).toBe('ROLE_REMOVED');
    expect(
      leaveReason({ ...person, roles: ['MECHANIC'], temporaryRoles: [] }),
    ).toBeNull();
  });
});
