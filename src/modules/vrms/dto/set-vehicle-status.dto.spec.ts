import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetVehicleStatusDto } from './set-vehicle-status.dto';

// Spec 0020, AC-1 and AC-3: the toggle body.
const AT = '2026-11-01T01:00:00.000Z';

async function check(body: Record<string, unknown>) {
  const dto = plainToInstance(SetVehicleStatusDto, body);
  const errors = await validate(dto);
  return { dto, failed: errors.map((e) => e.property) };
}

describe('SetVehicleStatusDto', () => {
  it('trims the reason and accepts 5 to 500 characters', async () => {
    const { dto, failed } = await check({
      status: 'DISABLED',
      reason: '   Retired   ',
      updatedAt: AT,
    });
    expect(failed).toEqual([]);
    expect(dto.reason).toBe('Retired');
  });

  it('rejects a reason that is blank or too short after trimming', async () => {
    for (const reason of ['      ', '  ab  ']) {
      const { failed } = await check({
        status: 'DISABLED',
        reason,
        updatedAt: AT,
      });
      expect(failed).toEqual(['reason']);
    }
  });

  it('rejects a reason over 500 characters', async () => {
    const { failed } = await check({
      status: 'DISABLED',
      reason: 'x'.repeat(501),
      updatedAt: AT,
    });
    expect(failed).toEqual(['reason']);
  });

  it('accepts only AVAILABLE and DISABLED as targets', async () => {
    for (const status of ['UNDER_REPAIR', 'UNDER_MAINTENANCE', 'available']) {
      const { failed } = await check({
        status,
        reason: 'A reason',
        updatedAt: AT,
      });
      expect(failed).toEqual(['status']);
    }
  });

  it('requires updatedAt', async () => {
    const { failed } = await check({ status: 'AVAILABLE', reason: 'Fixed up' });
    expect(failed).toEqual(['updatedAt']);
  });
});
