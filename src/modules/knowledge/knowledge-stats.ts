import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { KNOWLEDGE_SETTINGS } from './knowledge.settings';

// Spec 0007, Value sourcing. A "linked issue" is a RepairIssue with knowledgeEntryId = entry.id on a
// ticket that is not CANCELLED. The SQL returns medians with their sample counts; the pure functions
// below apply MIN_SAMPLES and the repeat rules, so they can be tested without a database.

export type StatsRow = {
  entry_id: string;
  seen_count: number;
  last_seen_at: Date | null;
  hours_median: number | null;
  hours_samples: number;
  days_median: number | null;
  days_samples: number;
  cost_median: number | null;
  cost_samples: number;
};

export type EntryStats = {
  seenCount: number;
  lastSeenAt: Date | null;
  /** Median hoursSpent, null under MIN_SAMPLES; the client falls back to estimatedHours. */
  typicalHours: number | null;
  hoursSamples: number;
  /** Median days from created to completed, one decimal, null under MIN_SAMPLES. */
  typicalDays: number | null;
  /** Median totalCost of single issue tickets, null under MIN_SAMPLES. Editors only. */
  typicalCost: number | null;
};

export type RepeatVehicleRow = { plate: string; count: number; last_at: Date };
export type RepeatVehicle = { plate: string; count: number; lastAt: Date };

const round = (value: number, places: number) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

export function resolveStats(
  row: StatsRow | undefined,
  minSamples: number = KNOWLEDGE_SETTINGS.MIN_SAMPLES,
): EntryStats {
  if (!row) {
    return {
      seenCount: 0,
      lastSeenAt: null,
      typicalHours: null,
      hoursSamples: 0,
      typicalDays: null,
      typicalCost: null,
    };
  }
  const enough = (median: number | null, samples: number) =>
    median != null && samples >= minSamples ? median : null;
  const hours = enough(row.hours_median, row.hours_samples);
  const days = enough(row.days_median, row.days_samples);
  const cost = enough(row.cost_median, row.cost_samples);
  return {
    seenCount: row.seen_count,
    lastSeenAt: row.last_seen_at,
    typicalHours: hours == null ? null : round(hours, 2),
    hoursSamples: row.hours_samples,
    typicalDays: days == null ? null : round(days, 1),
    typicalCost: cost == null ? null : round(cost, 2),
  };
}

/** At least REPEAT_THRESHOLD linked issues in the window, most repeats first, at most 5 (AC-14). */
export function pickRepeatVehicles(
  rows: RepeatVehicleRow[],
  threshold: number = KNOWLEDGE_SETTINGS.REPEAT_THRESHOLD,
): RepeatVehicle[] {
  return rows
    .filter((r) => r.count >= threshold)
    .sort(
      (a, b) => b.count - a.count || b.last_at.getTime() - a.last_at.getTime(),
    )
    .slice(0, 5)
    .map((r) => ({ plate: r.plate, count: r.count, lastAt: r.last_at }));
}

/** One query for every entry id, grouped by entry. */
export async function loadStats(
  prisma: PrismaService,
  entryIds: string[],
): Promise<Map<string, EntryStats>> {
  if (entryIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<StatsRow[]>(Prisma.sql`
    WITH linked AS (
      SELECT ri.knowledge_entry_id AS entry_id, ri.hours_spent, t.id AS ticket_id, t.repair_status,
             t.created_at, t.closed_at, t.total_cost
      FROM repair_issues ri
      JOIN repair_tickets t ON t.id = ri.repair_ticket_id
      WHERE ri.knowledge_entry_id = ANY(${entryIds}::uuid[]) AND t.repair_status <> 'CANCELLED'
    ),
    seen AS (
      SELECT entry_id,
             count(*)::int AS seen_count,
             max(created_at) AS last_seen_at,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_spent)
               FILTER (WHERE repair_status = 'CLOSED' AND hours_spent IS NOT NULL))::float8 AS hours_median,
             (count(*) FILTER (WHERE repair_status = 'CLOSED' AND hours_spent IS NOT NULL))::int AS hours_samples
      FROM linked
      GROUP BY entry_id
    ),
    days AS (
      SELECT entry_id,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - created_at) / 86400))::float8 AS days_median,
             count(*)::int AS days_samples
      FROM (
        SELECT DISTINCT entry_id, ticket_id, created_at, closed_at
        FROM linked
        WHERE repair_status = 'CLOSED' AND closed_at IS NOT NULL
      ) d
      GROUP BY entry_id
    ),
    cost AS (
      SELECT entry_id,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY total_cost))::float8 AS cost_median,
             count(*)::int AS cost_samples
      FROM linked l
      WHERE repair_status = 'CLOSED' AND total_cost IS NOT NULL
        AND (SELECT count(*) FROM repair_issues r2 WHERE r2.repair_ticket_id = l.ticket_id) = 1
      GROUP BY entry_id
    )
    SELECT s.entry_id, s.seen_count, s.last_seen_at, s.hours_median, s.hours_samples,
           d.days_median, coalesce(d.days_samples, 0)::int AS days_samples,
           c.cost_median, coalesce(c.cost_samples, 0)::int AS cost_samples
    FROM seen s
    LEFT JOIN days d USING (entry_id)
    LEFT JOIN cost c USING (entry_id)
  `);
  const byId = new Map(rows.map((r) => [r.entry_id, r]));
  return new Map(entryIds.map((id) => [id, resolveStats(byId.get(id))]));
}

export async function loadRepeatVehicles(
  prisma: PrismaService,
  entryId: string,
  now = new Date(),
) {
  const since = new Date(
    now.getTime() - KNOWLEDGE_SETTINGS.REPEAT_WINDOW_DAYS * 86_400_000,
  );
  const rows = await prisma.$queryRaw<RepeatVehicleRow[]>(Prisma.sql`
    SELECT v.plate_number AS plate, count(*)::int AS count, max(t.created_at) AS last_at
    FROM repair_issues ri
    JOIN repair_tickets t ON t.id = ri.repair_ticket_id
    JOIN vehicles v ON v.id = t.vehicle_id
    WHERE ri.knowledge_entry_id = ${entryId}::uuid
      AND t.repair_status <> 'CANCELLED'
      AND t.created_at >= ${since}
    GROUP BY v.id, v.plate_number
  `);
  return pickRepeatVehicles(rows);
}

/** Escapes LIKE wildcards so a typed % or _ matches itself. */
export function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

/** Entry ids matching the library search (Value sourcing: Library search). */
export async function searchEntryIds(
  prisma: PrismaService,
  q: string,
): Promise<string[]> {
  const pattern = likePattern(q);
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT e.id
    FROM knowledge_entries e
    WHERE e.name ILIKE ${pattern}
       OR e.symptoms ILIKE ${pattern}
       OR EXISTS (SELECT 1 FROM knowledge_entry_parts p WHERE p.entry_id = e.id AND p.name ILIKE ${pattern})
       OR word_similarity(${q}, e.name || ' ' || e.symptoms) >= ${KNOWLEDGE_SETTINGS.SEARCH_SIMILARITY}
  `);
  return rows.map((r) => r.id);
}
