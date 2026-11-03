import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VehicleChangesQueryDto } from './vehicle-changes-query.dto';

// Spec 0020, AC-9: GET /vrms/vehicles/:id/changes?cursor=&limit=
// Query values arrive as strings, so the same transform the global ValidationPipe runs is used.

async function errors(query: Record<string, unknown>) {
  const dto = plainToInstance(VehicleChangesQueryDto, query);
  const found = await validate(dto, { whitelist: true });
  return { dto, found };
}

describe('VehicleChangesQueryDto (AC-9)', () => {
  it('accepts no query at all', async () => {
    const { found } = await errors({});
    expect(found).toHaveLength(0);
  });

  it('reads limit from a string and accepts 1 to 50', async () => {
    for (const limit of ['1', '20', '50']) {
      const { dto, found } = await errors({ limit });
      expect(found).toHaveLength(0);
      expect(dto.limit).toBe(Number(limit));
    }
  });

  it('rejects a limit below 1 or above 50', async () => {
    for (const limit of ['0', '-3', '51', '500']) {
      const { found } = await errors({ limit });
      expect(found.map((e) => e.property)).toEqual(['limit']);
    }
  });

  it('rejects a limit that is not a whole number', async () => {
    for (const limit of ['2.5', 'abc']) {
      const { found } = await errors({ limit });
      expect(found.map((e) => e.property)).toEqual(['limit']);
    }
  });

  it('accepts a cursor up to 200 characters and rejects a longer one', async () => {
    expect((await errors({ cursor: 'a'.repeat(200) })).found).toHaveLength(0);
    const long = await errors({ cursor: 'a'.repeat(201) });
    expect(long.found.map((e) => e.property)).toEqual(['cursor']);
  });
});
