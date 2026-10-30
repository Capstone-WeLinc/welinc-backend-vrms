import { pickRepeatVehicles, resolveStats, StatsRow } from './knowledge-stats';

// The catalog defaults (spec 0012); the helpers take them as parameters
const MIN_SAMPLES = 3;
const REPEAT_THRESHOLD = 2;

// Spec 0007, AC-13 and AC-14 (Value sourcing): the SQL hands over medians with sample counts,
// and these rules decide what the entry page may show.

function row(overrides: Partial<StatsRow> = {}): StatsRow {
  return {
    entry_id: 'e1',
    seen_count: 5,
    last_seen_at: new Date('2026-10-20T00:00:00Z'),
    hours_median: 2.125,
    hours_samples: 3,
    days_median: 1.04,
    days_samples: 3,
    cost_median: 7097.5,
    cost_samples: 3,
    ...overrides,
  };
}

describe('resolveStats', () => {
  it('shows every median once each has MIN_SAMPLES (3) samples, rounded', () => {
    expect(resolveStats(row(), MIN_SAMPLES)).toEqual({
      seenCount: 5,
      lastSeenAt: new Date('2026-10-20T00:00:00Z'),
      typicalHours: 2.13,
      hoursSamples: 3,
      typicalDays: 1,
      typicalCost: 7097.5,
    });
  });

  it('hides a median with only 2 samples, so the page falls back to the estimate', () => {
    const stats = resolveStats(
      row({ hours_samples: 2, days_samples: 2, cost_samples: 2 }),
      MIN_SAMPLES,
    );
    expect(stats.typicalHours).toBeNull();
    expect(stats.typicalDays).toBeNull();
    expect(stats.typicalCost).toBeNull();
    // The count still tells the page how many samples there are
    expect(stats.hoursSamples).toBe(2);
    expect(stats.seenCount).toBe(5);
  });

  it('judges each median on its own sample count', () => {
    // A two issue ticket never feeds typical cost, so cost can have fewer samples than hours
    const stats = resolveStats(row({ cost_samples: 1 }), MIN_SAMPLES);
    expect(stats.typicalHours).toBe(2.13);
    expect(stats.typicalCost).toBeNull();
  });

  it('reads a never seen entry as zero with no medians', () => {
    expect(resolveStats(undefined, MIN_SAMPLES)).toEqual({
      seenCount: 0,
      lastSeenAt: null,
      typicalHours: null,
      hoursSamples: 0,
      typicalDays: null,
      typicalCost: null,
    });
  });

  it('treats a missing median as none even with enough samples', () => {
    expect(
      resolveStats(row({ cost_median: null }), MIN_SAMPLES).typicalCost,
    ).toBeNull();
  });
});

describe('pickRepeatVehicles', () => {
  const at = (d: string) => new Date(`2026-${d}T00:00:00Z`);

  it('keeps vehicles with at least REPEAT_THRESHOLD (2) issues, most repeats first, then newest', () => {
    const picked = pickRepeatVehicles(
      [
        { plate: 'AAA 111', count: 1, last_at: at('10-01') },
        { plate: 'BBB 222', count: 2, last_at: at('09-01') },
        { plate: 'CCC 333', count: 4, last_at: at('08-01') },
        { plate: 'DDD 444', count: 2, last_at: at('10-10') },
      ],
      REPEAT_THRESHOLD,
    );
    expect(picked.map((v) => v.plate)).toEqual([
      'CCC 333',
      'DDD 444',
      'BBB 222',
    ]);
    expect(picked[0]).toEqual({
      plate: 'CCC 333',
      count: 4,
      lastAt: at('08-01'),
    });
  });

  it('lists at most 5', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      plate: `P${i}`,
      count: 2 + i,
      last_at: at('10-01'),
    }));
    expect(pickRepeatVehicles(rows, REPEAT_THRESHOLD)).toHaveLength(5);
  });

  it('is empty when no vehicle repeats, so the card hides', () => {
    expect(
      pickRepeatVehicles(
        [{ plate: 'AAA 111', count: 1, last_at: at('10-01') }],
        REPEAT_THRESHOLD,
      ),
    ).toEqual([]);
  });
});
