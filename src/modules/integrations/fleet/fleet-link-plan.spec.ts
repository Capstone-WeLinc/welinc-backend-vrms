import {
  describeLinkPlan,
  hasDoubleClaims,
  planFleetLink,
  type LocalGarage,
  type LocalVehicle,
} from './fleet-link-plan';
import type { FleetVehicle } from './vmms-fleet.client';

// covers: spec 0029 AC-1 (the fleet:link plan)

const g = (
  id: string,
  name: string,
  over: Partial<LocalGarage> = {},
): LocalGarage => ({
  id,
  name,
  vmmsGarageId: null,
  isActive: true,
  tickets: 0,
  ...over,
});
const v = (
  id: string,
  plateNumber: string,
  over: Partial<LocalVehicle> = {},
): LocalVehicle => ({
  id,
  plateNumber,
  vmmsVehicleId: null,
  isActive: true,
  tickets: 0,
  ...over,
});
const fv = (id: string, plateNumber: string): FleetVehicle => ({
  id,
  plateNumber,
  make: 'Isuzu',
  model: 'NLR',
  year: 2022,
  truckSizeCategory: '6 Wheeler',
  capacity: 4000,
  odometer: 1000,
  status: 'AVAILABLE',
  garageId: null,
  updatedAt: '2026-11-27T00:00:00Z',
});

describe('planFleetLink', () => {
  it('matches garages by name and trucks by plate, trimmed and case insensitive', () => {
    const plan = planFleetLink(
      { garages: [g('lg1', ' Sta. Rosa ')], vehicles: [v('lv1', 'abc 1234')] },
      {
        garages: [{ id: 'G1', name: 'sta. rosa' }],
        vehicles: [fv('V1', 'ABC 1234 ')],
      },
    );
    expect(plan.garages.matches.map((m) => [m.local.id, m.remote.id])).toEqual([
      ['lg1', 'G1'],
    ]);
    expect(plan.vehicles.matches.map((m) => [m.local.id, m.remote.id])).toEqual(
      [['lv1', 'V1']],
    );
    expect(hasDoubleClaims(plan)).toBe(false);
  });

  it('lists unmatched VRMS rows to archive with their ticket counts, and VMMS records to add', () => {
    const plan = planFleetLink(
      {
        garages: [g('lg1', 'Pulilan')],
        vehicles: [
          v('lv1', 'OLD 0001', { tickets: 3 }),
          v('lv2', 'OLD 0002', { isActive: false }),
        ],
      },
      {
        garages: [{ id: 'G2', name: 'Marikina' }],
        vehicles: [fv('V9', 'NEW 0009')],
      },
    );
    expect(plan.vehicles.unmatched.map((u) => u.id)).toEqual(['lv1', 'lv2']);
    expect(plan.vehicles.missing.map((m) => m.id)).toEqual(['V9']);
    expect(plan.garages.missing.map((m) => m.id)).toEqual(['G2']);
    const text = describeLinkPlan(plan).join('\n');
    // Only active rows are archived; an already inactive one is left as it is
    expect(text).toContain('archive 1 (not in VMMS; tickets kept)');
    expect(text).toContain('OLD 0001 (3 tickets)');
    expect(text).not.toContain('OLD 0002');
  });

  it('stops on two VRMS plates that differ only in case', () => {
    const plan = planFleetLink(
      { garages: [], vehicles: [v('lv1', 'ABC 1234'), v('lv2', 'abc 1234')] },
      { garages: [], vehicles: [fv('V1', 'ABC 1234')] },
    );
    expect(hasDoubleClaims(plan)).toBe(true);
    expect(plan.vehicles.doubleClaims).toEqual([
      { key: 'ABC 1234', vmmsId: 'V1', localIds: ['lv1', 'lv2'] },
    ]);
    expect(plan.vehicles.matches).toEqual([]);
    // Neither claimer counts as matched, and the record isn't offered as missing either
    expect(plan.vehicles.missing).toEqual([]);
    expect(describeLinkPlan(plan).join('\n')).toContain(
      'STOP: 2 VRMS rows match VMMS "ABC 1234"',
    );
  });

  it('keeps an existing link on a rerun, even after VMMS renamed the plate', () => {
    const plan = planFleetLink(
      {
        garages: [],
        vehicles: [v('lv1', 'ABC 1234', { vmmsVehicleId: 'V1' })],
      },
      { garages: [], vehicles: [fv('V1', 'XYZ 9999')] },
    );
    expect(plan.vehicles.matches.map((m) => m.local.id)).toEqual(['lv1']);
    expect(plan.vehicles.missing).toEqual([]);
    expect(plan.vehicles.unmatched).toEqual([]);
  });

  it('leaves a linked row whose VMMS record is gone to the reconcile, never archiving it here', () => {
    const plan = planFleetLink(
      {
        garages: [],
        vehicles: [v('lv1', 'ABC 1234', { vmmsVehicleId: 'GONE' })],
      },
      { garages: [], vehicles: [] },
    );
    expect(plan.vehicles.unmatched).toEqual([]);
    expect(plan.vehicles.matches).toEqual([]);
  });
});
