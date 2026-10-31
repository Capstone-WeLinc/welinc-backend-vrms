import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  type AppAbility,
  canViewCosts,
} from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import { FINISHED_STATUSES } from '../vrms/ticket-statuses';

// Spec 0013, Metric rules. Every number is read live; counts are ::int and money
// ROUND(..., 2)::float8 in SQL, so no BigInt or Decimal reaches the JSON (AC-4).

/** Months are calendar months in Manila (WeLinc runs in one country). */
const TZ = 'Asia/Manila';

/** A cancelled ticket never counts toward spend or repair counts. */
const COUNTED = Prisma.sql`t.repair_status <> 'CANCELLED'`;

/** The peso fields nulled without ticket.costs.view (AC-5). */
export const PESO_FIELDS = [
  'total_spend',
  'cumulative_spend',
  'total_parts_cost',
  'avg_repair_cost',
  'avg_cost_per_repair',
] as const;

type PesoField = (typeof PESO_FIELDS)[number];
type Masked<T> = { [K in keyof T]: K extends PesoField ? T[K] | null : T[K] };

/** Nulls every peso field when the caller can't see costs; the one place that does (AC-5). */
export function maskCosts<T extends object>(
  row: T,
  showCosts: boolean,
): Masked<T> {
  if (showCosts) return row as Masked<T>;
  const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const field of PESO_FIELDS) {
    if (field in copy) copy[field] = null;
  }
  return copy as Masked<T>;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "2026-10" → "Oct 2026", in English whatever the server locale. */
export function monthLabel(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
}

export const AGING_BUCKETS = ['< 24h', '24-72h', '> 72h'] as const;

type Summary = {
  total_spend: number;
  total_repairs: number;
  total_vehicles: number;
  avg_cost_per_repair: number;
};

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(ability: AppAbility) {
    const [row] = await this.prisma.$queryRaw<Summary[]>`
      SELECT ROUND(COALESCE(SUM(COALESCE(t.total_cost, 0)), 0), 2)::float8 AS total_spend,
             COUNT(*)::int AS total_repairs,
             COUNT(DISTINCT t.vehicle_id)::int AS total_vehicles,
             CASE WHEN COUNT(*) = 0 THEN 0
                  ELSE ROUND(SUM(COALESCE(t.total_cost, 0)) / COUNT(*), 2)::float8 END AS avg_cost_per_repair
      FROM repair_tickets t
      WHERE ${COUNTED}
    `;
    return maskCosts(row, canViewCosts(ability));
  }

  async costTrends(ability: AppAbility) {
    const rows = await this.prisma.$queryRaw<
      {
        month: string;
        repair_count: number;
        total_spend: number;
        cumulative_spend: number;
      }[]
    >`
      WITH m AS (
        SELECT to_char(t.created_at AT TIME ZONE ${TZ}, 'YYYY-MM') AS month,
               COUNT(*)::int AS repair_count,
               SUM(COALESCE(t.total_cost, 0)) AS spend
        FROM repair_tickets t
        WHERE ${COUNTED}
        GROUP BY 1
      )
      SELECT month, repair_count,
             ROUND(spend, 2)::float8 AS total_spend,
             ROUND(SUM(spend) OVER (ORDER BY month), 2)::float8 AS cumulative_spend
      FROM m
      ORDER BY month
    `;
    return this.list(rows, ability);
  }

  async vehicleKpis(ability: AppAbility) {
    // With costs hidden, ordering by spend would leak it (AC-5)
    const order = canViewCosts(ability)
      ? Prisma.sql`total_repairs DESC, SUM(COALESCE(t.total_cost, 0)) DESC, v.plate_number`
      : Prisma.sql`total_repairs DESC, v.plate_number`;
    const rows = await this.prisma.$queryRaw<
      {
        vehicle_plate: string;
        vehicle_model: string;
        total_repairs: number;
        total_parts_cost: number;
        avg_repair_cost: number;
        latest_repair_date: string;
      }[]
    >`
      SELECT v.plate_number AS vehicle_plate,
             v.model AS vehicle_model,
             COUNT(*)::int AS total_repairs,
             ROUND(SUM(COALESCE(t.total_cost, 0)), 2)::float8 AS total_parts_cost,
             ROUND(SUM(COALESCE(t.total_cost, 0)) / COUNT(*), 2)::float8 AS avg_repair_cost,
             to_char(MAX(t.created_at) AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS latest_repair_date
      FROM repair_tickets t
      JOIN vehicles v ON v.id = t.vehicle_id
      WHERE ${COUNTED}
      GROUP BY v.id, v.plate_number, v.model
      ORDER BY ${order}
      LIMIT 10
    `;
    return this.list(rows, ability);
  }

  async issueFrequency() {
    const rows = await this.prisma.$queryRaw<
      { description: string; occurrence_count: number }[]
    >`
      SELECT ri.description, COUNT(*)::int AS occurrence_count
      FROM repair_issues ri
      JOIN repair_tickets t ON t.id = ri.repair_ticket_id
      WHERE ${COUNTED}
      GROUP BY ri.description
      ORDER BY occurrence_count DESC, ri.description
      LIMIT 10
    `;
    return { data: rows };
  }

  async statusBreakdown() {
    const rows = await this.prisma.$queryRaw<
      { status: string; count: number }[]
    >`
      SELECT t.repair_status::text AS status, COUNT(*)::int AS count
      FROM repair_tickets t
      GROUP BY 1
      ORDER BY count DESC, status
    `;
    return { data: rows };
  }

  async garageCosts(ability: AppAbility) {
    const order = canViewCosts(ability)
      ? Prisma.sql`SUM(COALESCE(t.total_cost, 0)) DESC, g.name`
      : Prisma.sql`g.name`;
    const rows = await this.prisma.$queryRaw<
      { garage: string; repair_count: number; total_spend: number }[]
    >`
      SELECT g.name AS garage,
             COUNT(*)::int AS repair_count,
             ROUND(SUM(COALESCE(t.total_cost, 0)), 2)::float8 AS total_spend
      FROM repair_tickets t
      JOIN garages g ON g.id = t.garage_id
      WHERE ${COUNTED}
      GROUP BY g.id, g.name
      ORDER BY ${order}
    `;
    return this.list(rows, ability);
  }

  async aging() {
    const [row] = await this.prisma.$queryRaw<
      { fresh: number; delayed: number; overdue: number }[]
    >`
      SELECT COUNT(*) FILTER (WHERE now() - t.created_at < interval '24 hours')::int AS fresh,
             COUNT(*) FILTER (WHERE now() - t.created_at >= interval '24 hours'
                                AND now() - t.created_at <= interval '72 hours')::int AS delayed,
             COUNT(*) FILTER (WHERE now() - t.created_at > interval '72 hours')::int AS overdue
      FROM repair_tickets t
      WHERE t.repair_status::text NOT IN (${Prisma.join(FINISHED_STATUSES)})
    `;
    // All three buckets, always
    const counts = [row.fresh, row.delayed, row.overdue];
    return {
      data: AGING_BUCKETS.map((bucket, i) => ({ bucket, count: counts[i] })),
    };
  }

  async velocity() {
    const rows = await this.prisma.$queryRaw<
      { month: string; count: number }[]
    >`
      SELECT to_char(t.created_at AT TIME ZONE ${TZ}, 'YYYY-MM') AS month,
             COUNT(*)::int AS count
      FROM repair_tickets t
      GROUP BY 1
      ORDER BY 1
    `;
    return {
      data: rows.map((r) => ({ date: monthLabel(r.month), count: r.count })),
    };
  }

  private list<T extends object>(rows: T[], ability: AppAbility) {
    const showCosts = canViewCosts(ability);
    return { data: rows.map((row) => maskCosts(row, showCosts)) };
  }
}
