import { UserRole } from '../../auth/roles';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import type { PrismaService } from '../../shared/prisma.service';
import {
  AGING_BUCKETS,
  AnalyticsService,
  PESO_FIELDS,
  maskCosts,
  monthLabel,
} from './analytics.service';

// Spec 0013, AC-4 and AC-5: cost nulling, month labels, and the SQL rules the service sends.

const admin = defaultAbility({
  sub: 'admin',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
});
// The default matrix gives a Mechanic no ticket.costs.view (the Chief has it since spec 0015)
const chief = defaultAbility({
  sub: 'chief',
  roles: [{ role: UserRole.MECHANIC, system: 'VRMS' }],
});

type SqlFragment = { strings: readonly string[]; values: unknown[] };

const isFragment = (v: unknown): v is SqlFragment =>
  typeof v === 'object' && v !== null && 'strings' in v && 'values' in v;

/** Writes a tagged template call as SQL text, expanding nested Prisma.sql fragments. */
function render(strings: readonly string[], values: unknown[]): string {
  return strings
    .map((part, i) => {
      if (i >= values.length) return part;
      const value = values[i];
      return (
        part + (isFragment(value) ? render(value.strings, value.values) : '?')
      );
    })
    .join('');
}

function serviceReturning(...results: unknown[][]) {
  const queryRaw = jest.fn();
  for (const rows of results) queryRaw.mockResolvedValueOnce(rows);
  queryRaw.mockResolvedValue([]);
  const service = new AnalyticsService({
    $queryRaw: queryRaw,
  } as unknown as PrismaService);
  /** The SQL text of the nth call, each bound value shown as ? */
  const sql = (n = 0): string => {
    const [strings, ...values] = queryRaw.mock.calls[n] as [
      readonly string[],
      ...unknown[],
    ];
    return render(strings, values);
  };
  /** The bound values of the nth call, outermost only */
  const bound = (n = 0): unknown[] =>
    (queryRaw.mock.calls[n] as unknown[]).slice(1);
  return { service, sql, bound };
}

describe('maskCosts (AC-5)', () => {
  const row = {
    total_spend: 100,
    cumulative_spend: 200,
    total_parts_cost: 300,
    avg_repair_cost: 400,
    avg_cost_per_repair: 500,
    total_repairs: 7,
    month: '2026-10',
  };

  it('nulls every peso field and keeps the rest', () => {
    const masked = maskCosts(row, false);
    for (const field of PESO_FIELDS) expect(masked[field]).toBeNull();
    expect(masked.total_repairs).toBe(7);
    expect(masked.month).toBe('2026-10');
  });

  it('returns the row as is with ticket.costs.view', () => {
    expect(maskCosts(row, true)).toEqual(row);
  });

  it('does not add a peso field the row never had', () => {
    expect(maskCosts({ count: 3 }, false)).toEqual({ count: 3 });
  });
});

describe('monthLabel', () => {
  it('writes English month names whatever the server locale', () => {
    expect(monthLabel('2026-10')).toBe('Oct 2026');
    expect(monthLabel('2027-01')).toBe('Jan 2027');
  });
});

describe('metric rules (AC-4)', () => {
  it('leaves cancelled tickets out of spend and counts', async () => {
    const { service, sql } = serviceReturning(
      [
        {
          total_spend: 0,
          total_repairs: 0,
          total_vehicles: 0,
          avg_cost_per_repair: 0,
        },
      ],
      [],
      [],
      [],
      [],
    );
    await service.summary(admin);
    await service.costTrends(admin);
    await service.vehicleKpis(admin);
    await service.issueFrequency();
    await service.garageCosts(admin);

    for (let n = 0; n < 5; n++) {
      expect(sql(n)).toContain("t.repair_status <> 'CANCELLED'");
    }
  });

  it('buckets months in Manila time and casts counts and money in SQL', async () => {
    const { service, sql } = serviceReturning([], []);
    await service.costTrends(admin);
    await service.velocity();

    expect(sql(0)).toContain('YYYY-MM');
    expect(sql(0)).toContain('AT TIME ZONE ?');
    expect(sql(0)).toContain('::int');
    expect(sql(0)).toContain('::float8');
    expect(sql(1)).toContain('AT TIME ZONE ?');
  });

  it('passes the Manila zone as a bound value', async () => {
    const { service, bound } = serviceReturning([]);
    await service.costTrends(admin);

    expect(bound()).toContain('Asia/Manila');
  });

  it('labels velocity months and returns every aging bucket even when empty', async () => {
    const { service } = serviceReturning(
      [{ month: '2026-10', count: 4 }],
      [{ fresh: 0, delayed: 2, overdue: 0 }],
    );

    expect(await service.velocity()).toEqual({
      data: [{ date: 'Oct 2026', count: 4 }],
    });
    expect(await service.aging()).toEqual({
      data: [
        { bucket: AGING_BUCKETS[0], count: 0 },
        { bucket: AGING_BUCKETS[1], count: 2 },
        { bucket: AGING_BUCKETS[2], count: 0 },
      ],
    });
  });
});

describe('cost hiding (AC-5)', () => {
  it('nulls the summary peso fields without ticket.costs.view', async () => {
    const row = {
      total_spend: 900,
      total_repairs: 3,
      total_vehicles: 2,
      avg_cost_per_repair: 300,
    };
    const hidden = serviceReturning([row]);
    const shown = serviceReturning([row]);

    expect(await hidden.service.summary(chief)).toEqual({
      total_spend: null,
      total_repairs: 3,
      total_vehicles: 2,
      avg_cost_per_repair: null,
    });
    expect(await shown.service.summary(admin)).toEqual(row);
  });

  it('sorts garages by name, not spend, when costs are hidden', async () => {
    const hidden = serviceReturning([]);
    const shown = serviceReturning([]);
    await hidden.service.garageCosts(chief);
    await shown.service.garageCosts(admin);

    expect(hidden.sql()).not.toContain('SUM(COALESCE(t.total_cost, 0)) DESC');
    expect(shown.sql()).toContain('SUM(COALESCE');
  });

  it('sorts vehicles by repairs then plate when costs are hidden', async () => {
    const hidden = serviceReturning([]);
    await hidden.service.vehicleKpis(chief);

    expect(hidden.sql()).toContain(
      'ORDER BY total_repairs DESC, v.plate_number',
    );
  });
});
