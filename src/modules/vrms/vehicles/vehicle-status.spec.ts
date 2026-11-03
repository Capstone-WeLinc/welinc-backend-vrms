import { Prisma, VehicleStatus } from '@prisma/client';
import { vehicleStatusChange } from './vehicle-status';

// Spec 0020, AC-1, AC-6, AC-7: the one writer of Vehicle.status. One history row per change,
// none when the status stays as it was.

const actor = {
  sub: '00000000-0000-4000-8000-000000000002',
  name: 'Victor Ramos',
  email: 'vrms.admin@welinc.com',
};

function client() {
  const tx = {
    vehicle: { update: jest.fn().mockResolvedValue({}) },
    vehicleChange: { create: jest.fn().mockResolvedValue({}) },
  };
  return { tx, db: tx as unknown as Prisma.TransactionClient };
}

describe('vehicleStatusChange', () => {
  it('writes the status and one history row with the actor from the token (AC-1, AC-6)', async () => {
    const { tx, db } = client();
    const changed = await vehicleStatusChange(db, {
      vehicleId: 'v1',
      before: VehicleStatus.AVAILABLE,
      after: VehicleStatus.UNDER_REPAIR,
      actor,
      note: null,
      repairTicketId: 't1',
    });
    expect(changed).toBe(true);
    expect(tx.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { status: 'UNDER_REPAIR' },
    });
    expect(tx.vehicleChange.create).toHaveBeenCalledTimes(1);
    expect(tx.vehicleChange.create).toHaveBeenCalledWith({
      data: {
        vehicleId: 'v1',
        field: 'status',
        before: 'AVAILABLE',
        after: 'UNDER_REPAIR',
        note: null,
        repairTicketId: 't1',
        actorUserId: actor.sub,
        actorName: 'Victor Ramos',
        actorEmail: actor.email,
      },
    });
  });

  it('carries the reason on a manual change and no ticket (AC-1)', async () => {
    const { tx, db } = client();
    await vehicleStatusChange(db, {
      vehicleId: 'v1',
      before: VehicleStatus.AVAILABLE,
      after: VehicleStatus.DISABLED,
      actor,
      note: 'Brakes failed inspection',
      repairTicketId: null,
    });
    expect(tx.vehicleChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        note: 'Brakes failed inspection',
        repairTicketId: null,
      }) as unknown,
    });
  });

  it('writes nothing when the status did not change (AC-6, AC-7)', async () => {
    const { tx, db } = client();
    const changed = await vehicleStatusChange(db, {
      vehicleId: 'v1',
      before: VehicleStatus.UNDER_REPAIR,
      after: VehicleStatus.UNDER_REPAIR,
      actor,
      note: null,
      repairTicketId: 't1',
    });
    expect(changed).toBe(false);
    expect(tx.vehicle.update).not.toHaveBeenCalled();
    expect(tx.vehicleChange.create).not.toHaveBeenCalled();
  });

  it('still writes the other fields of the same update, with no row, when the status stays (AC-7)', async () => {
    const { tx, db } = client();
    const changed = await vehicleStatusChange(db, {
      vehicleId: 'v1',
      before: VehicleStatus.AVAILABLE,
      after: VehicleStatus.AVAILABLE,
      actor,
      note: null,
      repairTicketId: 't1',
      also: { odometer: 1500 },
    });
    expect(changed).toBe(false);
    expect(tx.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { odometer: 1500 },
    });
    expect(tx.vehicleChange.create).not.toHaveBeenCalled();
  });

  it('writes the other fields together with the status when it changes (AC-7)', async () => {
    const { tx, db } = client();
    await vehicleStatusChange(db, {
      vehicleId: 'v1',
      before: VehicleStatus.UNDER_REPAIR,
      after: VehicleStatus.AVAILABLE,
      actor,
      note: null,
      repairTicketId: 't1',
      also: { odometer: 1500 },
    });
    expect(tx.vehicle.update).toHaveBeenCalledTimes(1);
    expect(tx.vehicle.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { odometer: 1500, status: 'AVAILABLE' },
    });
  });

  it('names the actor by email when the token has no name', async () => {
    const { tx, db } = client();
    await vehicleStatusChange(db, {
      vehicleId: 'v1',
      before: VehicleStatus.AVAILABLE,
      after: VehicleStatus.DISABLED,
      actor: { ...actor, name: '' },
      note: 'Engine seized',
      repairTicketId: null,
    });
    expect(tx.vehicleChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorName: actor.email }) as unknown,
    });
  });
});
