import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ExpediteRequestDto } from './bms-integration.dto';

// Spec 0029 AC-18: neededBy is optional, but when sent it must be a real calendar date
describe('ExpediteRequestDto neededBy', () => {
  const body = (neededBy?: string) =>
    plainToInstance(ExpediteRequestDto, {
      requestId: '5b8a3c7e-2f41-4d0b-9e6a-1c2d3e4f5a6b',
      vmmsVehicleId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
      jobOrderNumber: 'JO-2026-0142',
      reason: 'Client delivery on Monday',
      ...(neededBy !== undefined && { neededBy }),
    });

  const errorsOn = async (neededBy?: string) =>
    (await validate(body(neededBy))).map((e) => e.property);

  it('accepts a real date or none', async () => {
    expect(await errorsOn('2026-12-02')).toEqual([]);
    expect(await errorsOn('2028-02-29')).toEqual([]);
    expect(await errorsOn()).toEqual([]);
  });

  it.each([
    '2026-13-45',
    '2026-02-30',
    '2027-02-29',
    '02-12-2026',
    '2026-12-02T00:00:00Z',
  ])('refuses %s', async (value) => {
    expect(await errorsOn(value)).toEqual(['neededBy']);
  });
});
