import { Prisma, VehicleStatus } from '@prisma/client';
import { VEHICLE_TYPE_LIST } from '../../vrms/lookups/lookup-lists';
import { lookupNameKey } from '../../vrms/lookups/lookup-name';
import type { FleetGarage, FleetVehicle } from './vmms-fleet.client';

// Spec 0029 (child 0001): the only writers of the fields VRMS copies from VMMS. Each locks its
// local row first, so a change message and the reconcile never write the same history twice.

/** Who the sync's history rows name (AC-3). */
export const FLEET_ACTOR = 'VMMS';
const GARAGE_NAME_MAX = 50;
const PLATE_MAX = 20;
const MODEL_MAX = 100;
const SIZE_MAX = 50;

type Tx = Prisma.TransactionClient;

export type ApplyResult = {
  /** The local row, or null when it could not be created (a clash). */
  localId: string | null;
  created: boolean;
  /** The fields that changed (history fields only). */
  changed: string[];
  /** A clash that was skipped and must be reported: the other local row holds the value. */
  clash?: 'plate' | 'name';
};

const lockVehicle = (tx: Tx, vmmsVehicleId: string) =>
  tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM vehicles WHERE vmms_vehicle_id = ${vmmsVehicleId}::uuid FOR UPDATE
  `.then((rows) => rows[0]?.id ?? null);

const lockGarage = (tx: Tx, vmmsGarageId: string) =>
  tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM garages WHERE vmms_garage_id = ${vmmsGarageId}::uuid FOR UPDATE
  `.then((rows) => rows[0]?.id ?? null);

const json = (value: unknown) =>
  value === null || value === undefined
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue);

async function logChange(
  tx: Tx,
  vehicleId: string,
  field: string,
  before: unknown,
  after: unknown,
) {
  await tx.vehicleChange.create({
    data: {
      vehicleId,
      field,
      before: json(before),
      after: json(after),
      actorUserId: null,
      actorName: FLEET_ACTOR,
    },
  });
}

/**
 * The `vehicle_type` value named like the truck's size (trimmed, case insensitive), created by
 * the system when missing. Null when VMMS has no size.
 */
export async function vehicleTypeForSize(
  tx: Tx,
  size: string | null,
): Promise<{ id: string; name: string } | null> {
  const name = size?.trim().slice(0, 100);
  if (!name) return null;
  const nameKey = lookupNameKey(name);
  const found = await tx.lookupValue.findUnique({
    where: { list_nameKey: { list: VEHICLE_TYPE_LIST, nameKey } },
    select: { id: true, name: true },
  });
  if (found) return found;
  const top = await tx.lookupValue.aggregate({
    _max: { sortOrder: true },
    where: { list: VEHICLE_TYPE_LIST },
  });
  const created = await tx.lookupValue.create({
    data: {
      list: VEHICLE_TYPE_LIST,
      name,
      nameKey,
      sortOrder: (top._max.sortOrder ?? 0) + 1,
    },
    select: { id: true, name: true },
  });
  await tx.lookupValueChange.create({
    data: {
      lookupValueId: created.id,
      action: 'CREATE',
      before: Prisma.JsonNull,
      after: { name, isActive: true },
      actorUserId: null,
      actorName: FLEET_ACTOR,
    },
  });
  return created;
}

/** Applies one VMMS garage: links or creates the local row and copies its name. */
export async function applyFleetGarage(
  tx: Tx,
  record: FleetGarage,
  now: Date,
): Promise<ApplyResult> {
  const name = record.name.trim().slice(0, GARAGE_NAME_MAX);
  const localId = await lockGarage(tx, record.id);
  const clashing = await tx.garage.findFirst({
    where: { name, ...(localId ? { id: { not: localId } } : {}) },
    select: { id: true },
  });
  if (!localId) {
    if (clashing)
      return { localId: null, created: false, changed: [], clash: 'name' };
    const created = await tx.garage.create({
      data: { name, vmmsGarageId: record.id, isActive: true, syncedAt: now },
      select: { id: true },
    });
    return { localId: created.id, created: true, changed: [] };
  }
  const current = await tx.garage.findUniqueOrThrow({
    where: { id: localId },
    select: { name: true, isActive: true },
  });
  const changed: string[] = [];
  const data: Prisma.GarageUpdateInput = {
    syncedAt: now,
    isActive: true,
    deletedAt: null,
  };
  if (!current.isActive) changed.push('isActive');
  if (current.name !== name) {
    if (clashing) {
      await tx.garage.update({ where: { id: localId }, data });
      return { localId, created: false, changed, clash: 'name' };
    }
    data.name = name;
    changed.push('name');
  }
  await tx.garage.update({ where: { id: localId }, data });
  return { localId, created: false, changed };
}

type VehicleSnapshot = {
  plateNumber: string;
  model: string;
  make: string | null;
  capacity: number;
  truckSizeCategory: string | null;
  status: VehicleStatus;
  isActive: boolean;
  garage: { id: string; name: string } | null;
};

const SNAPSHOT_SELECT = {
  plateNumber: true,
  model: true,
  make: true,
  capacity: true,
  truckSizeCategory: true,
  status: true,
  isActive: true,
  garage: { select: { id: true, name: true } },
} as const;

/** The history fields, in the order their rows are written. Odometer is copied but not logged. */
const HISTORY_FIELDS = [
  'plateNumber',
  'model',
  'make',
  'capacity',
  'truckSizeCategory',
  'status',
  'garage',
  'isActive',
] as const;

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Applies one VMMS truck: links or creates the local row and copies every field (child 0001's
 * table). Each changed history field writes one `VehicleChange` row by VMMS. A plate that clashes
 * with another local row is skipped and reported; the other fields still apply.
 */
export async function applyFleetVehicle(
  tx: Tx,
  record: FleetVehicle,
  now: Date,
): Promise<ApplyResult> {
  const localId = await lockVehicle(tx, record.id);
  const plateNumber = record.plateNumber.trim().slice(0, PLATE_MAX);
  const garage = record.garageId
    ? await tx.garage.findUnique({
        where: { vmmsGarageId: record.garageId },
        select: { id: true, name: true },
      })
    : null;
  const vehicleType = await vehicleTypeForSize(tx, record.truckSizeCategory);
  const next: VehicleSnapshot = {
    plateNumber,
    model: record.model.trim().slice(0, MODEL_MAX),
    make: record.make?.trim().slice(0, MODEL_MAX) || null,
    capacity: Math.max(0, Math.round(record.capacity)),
    truckSizeCategory:
      record.truckSizeCategory?.trim().slice(0, SIZE_MAX) || null,
    status: record.status,
    isActive: true,
    garage,
  };
  const plateTaken = await tx.vehicle.findFirst({
    where: { plateNumber, ...(localId ? { id: { not: localId } } : {}) },
    select: { id: true },
  });
  const copied = {
    model: next.model,
    make: next.make,
    capacity: next.capacity,
    truckSizeCategory: next.truckSizeCategory,
    status: next.status,
    isActive: true,
    // VMMS owns whether a truck exists; a row soft deleted before the sync must come back, since
    // the pickers hide `deletedAt` rows
    deletedAt: null,
    odometer: Math.max(0, Math.round(record.odometer)),
    garageId: garage?.id ?? null,
    vehicleTypeId: vehicleType?.id ?? null,
    syncedAt: now,
  };

  if (!localId) {
    if (plateTaken)
      return { localId: null, created: false, changed: [], clash: 'plate' };
    const created = await tx.vehicle.create({
      data: { ...copied, plateNumber, vmmsVehicleId: record.id },
      select: { id: true },
    });
    return { localId: created.id, created: true, changed: [] };
  }

  const current = await tx.vehicle.findUniqueOrThrow({
    where: { id: localId },
    select: SNAPSHOT_SELECT,
  });
  const clash = plateTaken && current.plateNumber !== plateNumber;
  if (clash) next.plateNumber = current.plateNumber;
  await tx.vehicle.update({
    where: { id: localId },
    data: { ...copied, plateNumber: next.plateNumber },
  });
  const changed: string[] = [];
  for (const field of HISTORY_FIELDS) {
    if (!same(current[field], next[field])) {
      changed.push(field);
      await logChange(tx, localId, field, current[field], next[field]);
    }
  }
  return {
    localId,
    created: false,
    changed,
    ...(clash ? { clash: 'plate' as const } : {}),
  };
}

/**
 * VMMS no longer has this truck (a 404, or missing from the full list): it stays, inactive,
 * with one history row. Never deleted.
 */
export async function deactivateFleetVehicle(
  tx: Tx,
  vmmsVehicleId: string,
  now: Date,
): Promise<boolean> {
  const localId = await lockVehicle(tx, vmmsVehicleId);
  if (!localId) return false;
  const { count } = await tx.vehicle.updateMany({
    where: { id: localId, isActive: true },
    data: { isActive: false, syncedAt: now },
  });
  if (count === 1) await logChange(tx, localId, 'isActive', true, false);
  return count === 1;
}

/** The garage version: inactive, never deleted, its trucks keep their link. */
export async function deactivateFleetGarage(
  tx: Tx,
  vmmsGarageId: string,
  now: Date,
): Promise<boolean> {
  const localId = await lockGarage(tx, vmmsGarageId);
  if (!localId) return false;
  const { count } = await tx.garage.updateMany({
    where: { id: localId, isActive: true },
    data: { isActive: false, syncedAt: now },
  });
  return count === 1;
}
