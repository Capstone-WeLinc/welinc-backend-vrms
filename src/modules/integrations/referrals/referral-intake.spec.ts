import {
  canonicalJson,
  EMPTY_FINDING_LABEL,
  payloadHash,
  storedReferral,
} from './referral-intake';
import type { RepairReferralDto } from './repair-referral.dto';

// covers: spec 0029 AC-6 (duplicate detection and the lenient text rule)

const body = (over: Partial<RepairReferralDto> = {}): RepairReferralDto => ({
  referralId: '7d4f6a8e-1c2b-4f3a-9e8d-0a1b2c3d4e5f',
  vmmsVehicleId: '0b5e1f2a-3c4d-4e5f-8a9b-1c2d3e4f5a6b',
  vehiclePlate: 'NBX 4821',
  maintenanceScheduleId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  workOrderNumber: 'WO-2026-0412',
  odometerReading: 84210,
  findings: [
    {
      checklistItemId: 'brake-pads',
      label: 'Brake pads',
      note: 'Worn to 2 mm',
    },
  ],
  chiefMechanicRemarks: 'Front axle, replace before next trip',
  ...over,
});

describe('payloadHash', () => {
  it('is the same whatever the key order, and changes with any value', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(payloadHash(a)).toBe(payloadHash(b));
    expect(payloadHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash({ ...b, b: 2 })).not.toBe(payloadHash(a));
    // Array order is part of the body
    expect(payloadHash({ d: [2, 1] })).not.toBe(payloadHash({ d: [1, 2] }));
  });
});

describe('storedReferral', () => {
  it('keeps ordinary text as sent, trimmed', () => {
    expect(storedReferral(body({ vehiclePlate: ' NBX 4821 ' }))).toEqual({
      vehiclePlate: 'NBX 4821',
      workOrderNumber: 'WO-2026-0412',
      chiefMechanicRemarks: 'Front axle, replace before next trip',
      findings: [
        {
          checklistItemId: 'brake-pads',
          label: 'Brake pads',
          note: 'Worn to 2 mm',
        },
      ],
    });
  });

  it('accepts VMMS’s empty strings: an empty label becomes "Finding", empty notes and remarks null', () => {
    const stored = storedReferral(
      body({
        chiefMechanicRemarks: '',
        findings: [{ checklistItemId: '', label: '  ', note: '' }],
      }),
    );
    expect(stored.chiefMechanicRemarks).toBeNull();
    expect(stored.findings).toEqual([
      { checklistItemId: '', label: EMPTY_FINDING_LABEL, note: null },
    ]);
    expect(
      storedReferral(body({ chiefMechanicRemarks: null })).chiefMechanicRemarks,
    ).toBeNull();
  });

  it('cuts over long text to the column instead of refusing it', () => {
    const stored = storedReferral(
      body({
        vehiclePlate: 'P'.repeat(30),
        workOrderNumber: 'W'.repeat(60),
        chiefMechanicRemarks: 'r'.repeat(5000),
        findings: [
          {
            checklistItemId: 'x',
            label: 'L'.repeat(300),
            note: 'n'.repeat(3000),
          },
        ],
      }),
    );
    expect(stored.vehiclePlate).toHaveLength(20);
    expect(stored.workOrderNumber).toHaveLength(40);
    expect(stored.chiefMechanicRemarks).toHaveLength(4000);
    expect(stored.findings[0].label).toHaveLength(200);
    expect(stored.findings[0].note).toHaveLength(2000);
  });
});
