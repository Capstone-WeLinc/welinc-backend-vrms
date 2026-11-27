import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCategoryDto, UpdateCategoryDto } from './category.dto';

// Spec 0030, AC-4: a category's fix time is 0.25 to 720 hours, two decimals at most, and null
// clears it.

async function create(body: Record<string, unknown>) {
  return validate(
    plainToInstance(CreateCategoryDto, { name: 'Brakes', ...body }),
    { whitelist: true, forbidNonWhitelisted: true },
  );
}

async function update(body: Record<string, unknown>) {
  return validate(
    plainToInstance(UpdateCategoryDto, {
      lastUpdatedAt: '2026-11-27T06:00:00.000Z',
      ...body,
    }),
    { whitelist: true, forbidNonWhitelisted: true },
  );
}

describe.each([
  ['CreateCategoryDto', create],
  ['UpdateCategoryDto', update],
])('%s fix time (AC-4)', (_name, check) => {
  it.each([0.25, 1, 6, 48.5, 720])('accepts %p hours', async (fixHours) => {
    expect(await check({ fixHours })).toHaveLength(0);
  });

  it.each([0.1, 0, -1, 721, 1000])('refuses %p hours', async (fixHours) => {
    const errors = await check({ fixHours });
    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {}).join(' ')).toMatch(
      /0\.25 to 720 hours/,
    );
  });

  it('refuses a third decimal place and a non number', async () => {
    expect(await check({ fixHours: 1.234 })).toHaveLength(1);
    expect(await check({ fixHours: 'six' })).toHaveLength(1);
  });

  it('takes null to clear the fix time, and leaves it alone when absent', async () => {
    expect(await check({ fixHours: null })).toHaveLength(0);
    expect(await check({})).toHaveLength(0);
  });
});
