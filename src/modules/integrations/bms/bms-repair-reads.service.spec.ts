import type { PrismaService } from '../../../shared/prisma.service';
import { BmsRepairReadsService } from './bms-repair-reads.service';

// covers: spec 0029 AC-20 (the active repair BMS reads, child 0003)

function setup(ticket: Record<string, unknown> | null) {
  const prisma = {
    repairTicket: {
      findFirst: jest
        .fn<
          Promise<unknown>,
          [{ where: Record<string, unknown>; select: Record<string, unknown> }]
        >()
        .mockResolvedValue(ticket),
    },
  };
  return {
    prisma,
    service: new BmsRepairReadsService(prisma as unknown as PrismaService),
  };
}

describe('BmsRepairReadsService.activeRepair', () => {
  it('answers the open ticket with issues resolved of total, and selects no cost, note or person', async () => {
    const { service, prisma } = setup({
      id: 't1',
      repairNumber: 'REP-20261128-0003',
      repairStatus: 'IN_PROGRESS',
      dueAt: new Date('2026-12-01T09:00:00.000Z'),
      createdAt: new Date('2026-11-27T01:00:00.000Z'),
      issues: [
        { resolvedAt: new Date(), category: { name: 'Brakes', sortOrder: 1 } },
        { resolvedAt: null, category: null },
      ],
    });
    await expect(service.activeRepair('v1')).resolves.toEqual({
      repair: {
        repairTicketId: 't1',
        repairTicketNumber: 'REP-20261128-0003',
        repairStatus: 'IN_PROGRESS',
        repairStatusLabel: 'In progress',
        reason: 'Brakes',
        issuesResolved: 1,
        issuesTotal: 2,
        expectedReturnAt: '2026-12-01T09:00:00.000Z',
        openedAt: '2026-11-27T01:00:00.000Z',
      },
    });
    const query = prisma.repairTicket.findFirst.mock.calls[0][0];
    expect(query.where.vehicle).toEqual({ vmmsVehicleId: 'v1' });
    const fields = JSON.stringify(query.select);
    for (const hidden of [
      'Cost',
      'remarks',
      'driver',
      'reportedBy',
      'assignments',
      'description',
    ]) {
      expect(fields).not.toContain(hidden);
    }
  });

  it('answers repair null, not 404, for a truck with no open ticket', async () => {
    await expect(setup(null).service.activeRepair('v1')).resolves.toEqual({
      repair: null,
    });
  });
});
