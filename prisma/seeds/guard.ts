// Spec 0008, AC-13 and AC-15: which seed run may write, decided before any connection opens.
// The full seed follows welinc-auth's rule (suite spec 0006): production needs SEED_ALLOW=staging.
// `--reference` (garages, vehicles, knowledge base, settings; no people, no tickets) may run in
// production, but only into an empty database, so it can never wipe or double real data.

export const PRODUCTION_REFUSAL =
  'Seeding is off in production. Set SEED_ALLOW=staging only on the staging environment.';
export const REFERENCE_NOT_EMPTY =
  '--reference fills an empty database only, and this one already has garages, vehicles or knowledge entries. Nothing was written.';

export type SeedMode = 'full' | 'reference';

export type SeedDecision =
  | { ok: true; mode: SeedMode }
  | { ok: false; message: string };

export function seedGuard(input: {
  nodeEnv: string | undefined;
  seedAllow: string | undefined;
  args: string[];
}): SeedDecision {
  if (input.args.includes('--reference')) return { ok: true, mode: 'reference' };
  // Any value other than `staging` counts as unset
  if (input.nodeEnv === 'production' && input.seedAllow !== 'staging') {
    return { ok: false, message: PRODUCTION_REFUSAL };
  }
  return { ok: true, mode: 'full' };
}

/** The `--reference` check once connected: any existing reference row refuses the run. */
export function referenceProblem(counts: {
  garages: number;
  vehicles: number;
  knowledgeEntries: number;
}): string | null {
  return counts.garages + counts.vehicles + counts.knowledgeEntries > 0
    ? REFERENCE_NOT_EMPTY
    : null;
}
