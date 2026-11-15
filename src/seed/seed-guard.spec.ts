import {
  PRODUCTION_REFUSAL,
  REFERENCE_NOT_EMPTY,
  referenceProblem,
  seedGuard,
} from '../../prisma/seeds/guard';

// Spec 0008, AC-13 and AC-15
describe('seedGuard', () => {
  const run = (
    nodeEnv: string | undefined,
    seedAllow?: string,
    args: string[] = [],
  ) => seedGuard({ nodeEnv, seedAllow, args });

  it('runs the full seed locally and in tests', () => {
    expect(run(undefined)).toEqual({ ok: true, mode: 'full' });
    expect(run('development')).toEqual({ ok: true, mode: 'full' });
    expect(run('test')).toEqual({ ok: true, mode: 'full' });
  });

  it('refuses the full seed in production without SEED_ALLOW=staging', () => {
    expect(run('production')).toEqual({
      ok: false,
      message: PRODUCTION_REFUSAL,
    });
    expect(run('production', 'yes')).toEqual({
      ok: false,
      message: PRODUCTION_REFUSAL,
    });
    expect(run('production', 'STAGING')).toEqual({
      ok: false,
      message: PRODUCTION_REFUSAL,
    });
  });

  it('runs the full seed on staging with SEED_ALLOW=staging', () => {
    expect(run('production', 'staging')).toEqual({ ok: true, mode: 'full' });
  });

  it('allows --reference in production with no flag', () => {
    expect(run('production', undefined, ['--reference'])).toEqual({
      ok: true,
      mode: 'reference',
    });
  });

  it('uses the same refusal text as welinc-auth', () => {
    expect(PRODUCTION_REFUSAL).toBe(
      'Seeding is off in production. Set SEED_ALLOW=staging only on the staging environment.',
    );
  });
});

describe('referenceProblem', () => {
  it('accepts an empty database', () => {
    expect(
      referenceProblem({ garages: 0, vehicles: 0, knowledgeEntries: 0 }),
    ).toBeNull();
  });

  it.each([
    { garages: 1, vehicles: 0, knowledgeEntries: 0 },
    { garages: 0, vehicles: 3, knowledgeEntries: 0 },
    { garages: 0, vehicles: 0, knowledgeEntries: 9 },
  ])('refuses when reference rows exist (%o)', (counts) => {
    expect(referenceProblem(counts)).toBe(REFERENCE_NOT_EMPTY);
  });
});
