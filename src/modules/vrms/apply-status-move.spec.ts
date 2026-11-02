import { ConflictException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { applyStatusMove, MovingTicket } from './apply-status-move';
import { Actor, createdEvent } from './audit-events';
import { findMove } from './ticket-transitions';

// Spec 0014: every effect of one status move, inside the caller's transaction.

const NOW = new Date('2026-10-31T10:00:00.000Z');
const LOADED = new Date('2026-10-31T09:00:00.000Z');

const actor: Actor = {
  sub: 'chief-1',
  email: 'chief@welinc.com',
  name: 'Ramon Villanueva',
  roles: [{ role: 'CHIEF_MECHANIC', system: 'VRMS' }],
  system: 'VRMS',
};

function ticket(status: RepairStatus, odometer = 200000): MovingTicket {
  return {
    id: 'ticket-1',
    repairStatus: status,
    updatedAt: LOADED,
    vehicleId: 'vehicle-1',
    odometer,
    priorVehicleStatus: null,
  };
}

function makeTx(updateCount = 1, vehicleOdometer = 150000) {
  const calls: string[] = [];
  const tx = {
    repairTicket: {
      updateMany: jest.fn(() => {
        calls.push('ticket');
        return Promise.resolve({ count: updateCount });
      }),
    },
    repairIssue: {
      update: jest.fn(() => {
        calls.push('issue.update');
        return Promise.resolve();
      }),
      updateMany: jest.fn(() => {
        calls.push('issue.updateMany');
        return Promise.resolve();
      }),
    },
    auditLog: {
      create: jest.fn(() => {
        calls.push('audit');
        return Promise.resolve();
      }),
    },
    vehicle: {
      findUniqueOrThrow: jest.fn(() => {
        calls.push('vehicle.read');
        return Promise.resolve({ odometer: vehicleOdometer });
      }),
      update: jest.fn(() => {
        calls.push('vehicle.update');
        return Promise.resolve();
      }),
    },
  };
  return { tx: tx as never, raw: tx, calls };
}

function move(from: RepairStatus, to: RepairStatus) {
  const m = findMove(from, to);
  if (!m) throw new Error(`no move ${from} to ${to}`);
  return m;
}

describe('applyStatusMove', () => {
  it('refuses a move that does not start from the ticket status (AC-1)', async () => {
    const { tx, raw } = makeTx();
    await expect(
      applyStatusMove(
        tx,
        ticket(RepairStatus.ASSIGNED),
        move(RepairStatus.FOR_VERIFICATION, RepairStatus.CLOSED),
        actor,
        null,
        NOW,
      ),
    ).rejects.toThrow('does not start from ASSIGNED');
    expect(raw.repairTicket.updateMany).not.toHaveBeenCalled();
  });

  it('updates only the loaded updatedAt and writes nothing more on a lost race (AC-12)', async () => {
    const { tx, raw, calls } = makeTx(0);
    await expect(
      applyStatusMove(
        tx,
        ticket(RepairStatus.FOR_VERIFICATION),
        move(RepairStatus.FOR_VERIFICATION, RepairStatus.CLOSED),
        actor,
        null,
        NOW,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(raw.repairTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ticket-1', updatedAt: LOADED },
      }),
    );
    expect(calls).toEqual(['ticket']);
  });

  it('records when work started on the move into In progress or Outsourced, only once (spec 0018)', async () => {
    for (const [from, to] of [
      [RepairStatus.ASSIGNED, RepairStatus.IN_PROGRESS],
      [RepairStatus.ASSIGNED, RepairStatus.OUTSOURCED],
    ] as const) {
      const { tx, raw } = makeTx();
      await applyStatusMove(tx, ticket(from), move(from, to), actor, null, NOW);
      expect(raw.repairTicket.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'ticket-1', workStartedAt: null },
        data: { workStartedAt: NOW, updatedAt: NOW },
      });
    }
  });

  it('leaves work started alone on every other move (spec 0018)', async () => {
    const { tx, raw } = makeTx();
    await applyStatusMove(
      tx,
      ticket(RepairStatus.IN_PROGRESS),
      move(RepairStatus.IN_PROGRESS, RepairStatus.FOR_VERIFICATION),
      actor,
      null,
      NOW,
    );
    expect(raw.repairTicket.updateMany).toHaveBeenCalledTimes(1);
  });

  it('writes in the order ticket, issues, audit, vehicle (AC-12)', async () => {
    const { tx, calls } = makeTx();
    await applyStatusMove(
      tx,
      ticket(RepairStatus.FOR_VERIFICATION),
      move(RepairStatus.FOR_VERIFICATION, RepairStatus.CLOSED),
      actor,
      null,
      NOW,
      { issues: [{ id: 'issue-1', data: { resolutionNote: 'fixed' } }] },
    );
    expect(calls).toEqual([
      'ticket',
      'issue.update',
      'audit',
      'vehicle.read',
      'vehicle.update',
    ]);
  });

  it('records the caller as verifier and closes the ticket on Verify (AC-7)', async () => {
    const { tx, raw } = makeTx();
    await applyStatusMove(
      tx,
      ticket(RepairStatus.FOR_VERIFICATION),
      move(RepairStatus.FOR_VERIFICATION, RepairStatus.CLOSED),
      actor,
      null,
      NOW,
    );
    expect(raw.repairTicket.updateMany).toHaveBeenCalledWith({
      where: { id: 'ticket-1', updatedAt: LOADED },
      data: expect.objectContaining({
        repairStatus: RepairStatus.CLOSED,
        updatedAt: NOW,
        lastActivityAt: NOW,
        isUnlocked: false,
        closedAt: NOW,
        verifiedByUserId: 'chief-1',
        verifiedByName: 'Ramon Villanueva',
        verifiedAt: NOW,
      }) as Record<string, unknown>,
    });
  });

  it('frees the vehicle and lifts its odometer when the ticket reading is higher (AC-7)', async () => {
    const { tx, raw } = makeTx(1, 150000);
    await applyStatusMove(
      tx,
      ticket(RepairStatus.FOR_VERIFICATION, 200000),
      move(RepairStatus.FOR_VERIFICATION, RepairStatus.CLOSED),
      actor,
      null,
      NOW,
    );
    expect(raw.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'vehicle-1' },
      data: { status: 'AVAILABLE', odometer: 200000 },
    });
  });

  it('leaves the vehicle odometer alone when the ticket reading is lower (AC-7)', async () => {
    const { tx, raw } = makeTx(1, 150000);
    await applyStatusMove(
      tx,
      ticket(RepairStatus.FOR_VERIFICATION, 100000),
      move(RepairStatus.FOR_VERIFICATION, RepairStatus.CLOSED),
      actor,
      null,
      NOW,
    );
    expect(raw.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'vehicle-1' },
      data: { status: 'AVAILABLE' },
    });
  });

  it('cancels with closedAt, no verifier, and an untouched odometer (AC-10)', async () => {
    const { tx, raw } = makeTx(1, 150000);
    await applyStatusMove(
      tx,
      ticket(RepairStatus.IN_PROGRESS, 999999),
      move(RepairStatus.IN_PROGRESS, RepairStatus.CANCELLED),
      actor,
      null,
      NOW,
      { data: { cancellationReason: 'Duplicate' } },
    );
    const data = (
      raw.repairTicket.updateMany.mock.calls[0] as unknown[]
    )[0] as {
      data: Record<string, unknown>;
    };
    expect(data.data).toMatchObject({
      repairStatus: RepairStatus.CANCELLED,
      closedAt: NOW,
      cancellationReason: 'Duplicate',
    });
    expect(data.data).not.toHaveProperty('verifiedByUserId');
    expect(raw.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'vehicle-1' },
      data: { status: 'AVAILABLE' },
    });
  });

  it('puts a truck that was Disabled before the repair back to Disabled (spec 0016, AC-9)', async () => {
    const { tx, raw } = makeTx();
    await applyStatusMove(
      tx,
      {
        ...ticket(RepairStatus.FOR_VERIFICATION),
        priorVehicleStatus: 'DISABLED',
      },
      move(RepairStatus.FOR_VERIFICATION, RepairStatus.CLOSED),
      actor,
      null,
      NOW,
    );
    expect(raw.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'vehicle-1' },
      data: expect.objectContaining({ status: 'DISABLED' }) as unknown,
    });
  });

  it('clears resolvedAt on every issue of a ticket sent back, keeping notes (AC-9)', async () => {
    const { tx, raw } = makeTx();
    await applyStatusMove(
      tx,
      ticket(RepairStatus.FOR_VERIFICATION),
      move(RepairStatus.FOR_VERIFICATION, RepairStatus.IN_PROGRESS),
      actor,
      'Rear pads still squeal',
      NOW,
    );
    expect(raw.repairIssue.updateMany).toHaveBeenCalledWith({
      where: { repairTicketId: 'ticket-1' },
      data: { resolvedAt: null },
    });
  });

  it('keeps the vehicle under repair on a move into an open status (AC-8)', async () => {
    const { tx, raw } = makeTx();
    await applyStatusMove(
      tx,
      ticket(RepairStatus.ASSIGNED),
      move(RepairStatus.ASSIGNED, RepairStatus.IN_PROGRESS),
      actor,
      null,
      NOW,
    );
    // Only a move into a finished status releases the truck
    expect(raw.vehicle.update).not.toHaveBeenCalled();
    expect(raw.vehicle.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('writes a STATUS_CHANGE audit row carrying the trimmed note (AC-8)', async () => {
    const { tx, raw } = makeTx();
    await applyStatusMove(
      tx,
      ticket(RepairStatus.FOR_VERIFICATION),
      move(RepairStatus.FOR_VERIFICATION, RepairStatus.IN_PROGRESS),
      actor,
      '  Rear pads still squeal  ',
      NOW,
    );
    expect(raw.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        repairTicketId: 'ticket-1',
        action: 'STATUS_CHANGE',
        note: 'Rear pads still squeal',
        changes: [
          {
            field: 'repairStatus',
            before: 'FOR_VERIFICATION',
            after: 'IN_PROGRESS',
          },
        ],
        actorUserId: 'chief-1',
        createdAt: NOW,
      }) as Record<string, unknown>,
    });
  });

  it('writes the caller supplied audit row instead of STATUS_CHANGE (AC-1)', async () => {
    const { tx, raw } = makeTx();
    await applyStatusMove(
      tx,
      ticket(RepairStatus.ASSIGNED),
      move(RepairStatus.ASSIGNED, RepairStatus.OPEN),
      actor,
      null,
      NOW,
      { audit: createdEvent() },
    );
    expect(raw.auditLog.create).toHaveBeenCalledTimes(1);
    expect(raw.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'CREATED' }) as Record<
        string,
        unknown
      >,
    });
  });
});
