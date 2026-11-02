import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRepairDto } from './create-repair.dto';
import { mechanicsChangedEvent } from '../audit-events';

// Spec 0016, AC-5 and AC-6: the body rules that need no database.

const CAT = '00000000-0000-4000-8000-0000000000c1';
const ENTRY = '00000000-0000-4000-8000-0000000000e1';

const base = {
  vehiclePlate: 'ABC 123',
  garageLocation: 'Sta. Rosa',
  accountType: 'ONLINE',
  odometerReading: 1000,
  priority: 'LOW',
  driverId: '00000000-0000-4000-8000-0000000000d1',
  issues: [{ categoryId: CAT, rootCause: 'Wear', description: 'grinding' }],
};

async function check(overrides: Record<string, unknown>) {
  const dto = plainToInstance(CreateRepairDto, { ...base, ...overrides });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

describe('CreateRepairDto', () => {
  it('accepts a body with no mechanics (AC-1)', async () => {
    expect((await check({})).errors).toHaveLength(0);
  });

  it('rejects the old issueDescription and driverName fields (AC-5)', async () => {
    expect(
      (await check({ issueDescription: 'x' })).errors.length,
    ).toBeGreaterThan(0);
    expect((await check({ driverName: 'x' })).errors.length).toBeGreaterThan(0);
  });

  it('needs an account type (AC-4)', async () => {
    expect(
      (await check({ accountType: undefined })).errors.length,
    ).toBeGreaterThan(0);
    expect(
      (await check({ accountType: 'OTHER' })).errors.length,
    ).toBeGreaterThan(0);
  });

  describe('new driver license (AC-6)', () => {
    const withLicense = (licenseNumber: string, name = 'Pedro') =>
      check({ driverId: undefined, newDriver: { name, licenseNumber } });

    it('trims and uppercases a valid license', async () => {
      const { dto, errors } = await withLicense('  a01-23-456789 ');
      expect(errors).toHaveLength(0);
      expect(dto.newDriver?.licenseNumber).toBe('A01-23-456789');
    });

    it.each([
      'A01-23-45678',
      'A0123456789',
      '101-23-456789',
      'AB1-23-456789',
      '',
    ])('refuses %p with the format message', async (license) => {
      const { errors } = await withLicense(license);
      const messages = JSON.stringify(errors);
      expect(messages).toContain('Use the format A01-23-456789.');
    });

    it('trims the name and refuses a blank or 101 character one', async () => {
      const ok = await withLicense('A01-23-456789', '  Pedro  ');
      expect(ok.dto.newDriver?.name).toBe('Pedro');
      expect(
        (await withLicense('A01-23-456789', '   ')).errors.length,
      ).toBeGreaterThan(0);
      expect(
        (await withLicense('A01-23-456789', 'x'.repeat(101))).errors.length,
      ).toBeGreaterThan(0);
    });
  });

  describe('issue description (AC-5)', () => {
    it('is required without a knowledge entry, even when blank after trimming', async () => {
      const { errors } = await check({
        issues: [{ categoryId: CAT, rootCause: 'Wear', description: '   ' }],
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('may be blank or missing with a knowledge entry', async () => {
      const blank = await check({
        issues: [
          {
            categoryId: CAT,
            rootCause: 'Wear',
            knowledgeEntryId: ENTRY,
            description: '  ',
          },
        ],
      });
      const missing = await check({
        issues: [
          { categoryId: CAT, rootCause: 'Wear', knowledgeEntryId: ENTRY },
        ],
      });
      expect(blank.errors).toHaveLength(0);
      expect(missing.errors).toHaveLength(0);
    });

    it('still stops at 500 characters when typed', async () => {
      const { errors } = await check({
        issues: [
          {
            categoryId: CAT,
            rootCause: 'Wear',
            knowledgeEntryId: ENTRY,
            description: 'x'.repeat(501),
          },
        ],
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});

describe('mechanicsChangedEvent (spec 0016, AC-17; spec 0019, AC-12)', () => {
  it('lists one mechanic change per name, then the status move', () => {
    expect(
      mechanicsChangedEvent('added', ['Ana', 'Ben'], {
        from: 'OPEN',
        to: 'ASSIGNED',
      }),
    ).toEqual({
      action: 'MECHANIC_ASSIGNED',
      changes: [
        { field: 'mechanic', before: null, after: 'Ana' },
        { field: 'mechanic', before: null, after: 'Ben' },
        { field: 'repairStatus', before: 'OPEN', after: 'ASSIGNED' },
      ],
      note: null,
    });
  });

  it('lists the removed names with no move, and carries the note', () => {
    expect(
      mechanicsChangedEvent('removed', ['Ana'], null, 'Wrong mechanic'),
    ).toEqual({
      action: 'MECHANIC_UNASSIGNED',
      changes: [{ field: 'mechanic', before: 'Ana', after: null }],
      note: 'Wrong mechanic',
    });
  });
});
