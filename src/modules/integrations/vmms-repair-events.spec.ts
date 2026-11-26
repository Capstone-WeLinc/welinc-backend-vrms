import type { Prisma } from '@prisma/client';
import { queueVmmsRepairEvent, vmmsRepairStatus } from './vmms-repair-events';

// covers: spec 0029 AC-13 (the repair event payload, child 0002)

const AT = new Date('2026-11-27T03:04:05.678Z');

function tx(ticket: Record<string, unknown>) {
  const created: { data: Record<string, unknown> }[] = [];
  const fake = {
    repairTicket: { findUniqueOrThrow: jest.fn().mockResolvedValue(ticket) },
    $queryRaw: jest.fn().mockResolvedValue([{ at: AT }]),
    delivery: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args);
        return Promise.resolve({});
      }),
    },
  };
  return { client: fake as unknown as Prisma.TransactionClient, created };
}

const base = {
  repairNumber: 'REP-20261127-0007',
  repairStatus: 'ASSIGNED',
  outsideShopName: null,
  vehicle: { vmmsVehicleId: '0b5e1f2a-3c4d-4e5f-8a9b-1c2d3e4f5a6b' },
  referrals: [
    { id: 'r1', maintenanceScheduleId: 's1' },
    { id: 'r2', maintenanceScheduleId: 's1' },
  ],
};

describe('vmmsRepairStatus', () => {
  it('maps every status to itself, and Pending approval to Outsourced', () => {
    expect(vmmsRepairStatus('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(vmmsRepairStatus('CLOSED')).toBe('CLOSED');
    expect(vmmsRepairStatus('PENDING_APPROVAL')).toBe('OUTSOURCED');
  });
});

describe('queueVmmsRepairEvent', () => {
  it('queues the full state for VMMS, with no version, the schedules once and occurredAt in UTC', async () => {
    const { client, created } = tx(base);
    await queueVmmsRepairEvent(client, 't1', 'STATUS_UPDATED');
    const row = created[0].data;
    expect(row).toMatchObject({
      target: 'VMMS',
      kind: 'REPAIR_EVENT',
      repairTicketId: 't1',
    });
    const payload = row.payload as Record<string, unknown>;
    expect(payload).toEqual({
      eventId: row.id,
      repairTicketId: 't1',
      repairTicketNumber: 'REP-20261127-0007',
      eventType: 'STATUS_UPDATED',
      repairStatus: 'ASSIGNED',
      vmmsVehicleId: base.vehicle.vmmsVehicleId,
      maintenanceScheduleIds: ['s1'],
      acceptedReferralIds: ['r1', 'r2'],
      occurredAt: '2026-11-27T03:04:05.678Z',
    });
    expect(payload).not.toHaveProperty('eventVersion');
  });

  it('always sends OPEN with OPENED, whatever the ticket’s status', async () => {
    const { client, created } = tx(base);
    await queueVmmsRepairEvent(client, 't1', 'OPENED');
    expect(created[0].data.payload).toMatchObject({
      eventType: 'OPENED',
      repairStatus: 'OPEN',
    });
  });

  it('carries the outside shop only with OUTSOURCED, including Pending approval', async () => {
    const shop = { ...base, outsideShopName: 'Batangas Truck Works' };
    for (const [status, sent] of [
      ['OUTSOURCED', 'OUTSOURCED'],
      ['PENDING_APPROVAL', 'OUTSOURCED'],
    ]) {
      const { client, created } = tx({ ...shop, repairStatus: status });
      await queueVmmsRepairEvent(client, 't1', 'STATUS_UPDATED');
      expect(created[0].data.payload).toMatchObject({
        repairStatus: sent,
        outsideShopName: 'Batangas Truck Works',
      });
    }
    const { client, created } = tx({ ...shop, repairStatus: 'IN_PROGRESS' });
    await queueVmmsRepairEvent(client, 't1', 'STATUS_UPDATED');
    expect(created[0].data.payload).not.toHaveProperty('outsideShopName');
  });

  it('sends empty lists for a ticket a person opened', async () => {
    const { client, created } = tx({ ...base, referrals: [] });
    await queueVmmsRepairEvent(client, 't1', 'OPENED');
    expect(created[0].data.payload).toMatchObject({
      maintenanceScheduleIds: [],
      acceptedReferralIds: [],
    });
  });

  it('queues nothing for a truck not linked to VMMS yet', async () => {
    const { client, created } = tx({
      ...base,
      vehicle: { vmmsVehicleId: null },
    });
    await expect(queueVmmsRepairEvent(client, 't1', 'OPENED')).resolves.toEqual(
      {
        skipped: 'NOT_LINKED',
      },
    );
    expect(created).toEqual([]);
  });
});
