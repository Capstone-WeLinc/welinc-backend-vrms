import type { DueAtSource, Prisma, RepairPriority } from '@prisma/client';
import { loadStats, type EntryStats } from '../knowledge/knowledge-stats';
import { setDueAt } from '../integrations/bms/set-due-at';
import type { SettingsService } from '../../settings/settings.service';
import type { RowActor } from './audit-events';
import { isFinished } from './ticket-statuses';

// Spec 0030: the one due date calculator. computeDueAt is pure; recomputeDueAt loads a ticket's
// inputs inside the caller's transaction (which holds the row lock) and writes only through
// setDueAt. Nothing here runs on read: a stored date changes only at the moments in AC-5.

const HOUR_MS = 3_600_000;
/** AC-3: the issue sum never exceeds 90 days. */
export const MAX_ISSUE_HOURS = 2160;
/** AC-8: a hand date is at most 90 days from now. */
export const MAX_MANUAL_DAYS = 90;
const REASON_MAX = 500;

export type IssueHoursFrom = 'KNOWLEDGE' | 'ESTIMATE' | 'CATEGORY' | 'NONE';

export type DueIssueInput = {
  id: string;
  description: string;
  categoryName: string | null;
  /** issue_categories.fix_hours, already a number */
  categoryFixHours: number | null;
  knowledgeEntryId: string | null;
  /** knowledge_entries.estimated_hours, already a number */
  estimatedHours: number | null;
};

export type DueSettings = {
  priorityHours: Record<RepairPriority, number>;
  knowledgeOn: boolean;
};

export type DueIssueHours = {
  id: string;
  description: string;
  categoryName: string | null;
  hours: number;
  from: IssueHoursFrom;
  /** Closed repairs behind a KNOWLEDGE value, for the reason text */
  samples: number;
};

export type DueResult = {
  dueAt: Date;
  source: Exclude<DueAtSource, 'MANUAL'>;
  priority: RepairPriority;
  priorityHours: number;
  issueHours: number;
  escalated: boolean;
  issues: DueIssueHours[];
};

/** What started a recompute; it picks the reason's prefix (spec 0030, rule step 5). */
export type DueTrigger =
  | 'CREATE'
  | 'PRIORITY'
  | 'ISSUE_ADDED'
  | 'ISSUE_REMOVED'
  | 'ISSUE_CHANGED'
  | 'KNOWN_FIX'
  | 'REFERRAL'
  | 'BACKFILL'
  | { expedite: string }
  | { reset: string };

const round2 = (value: number) => Math.round(value * 100) / 100;

export function decimalHours(
  value: Prisma.Decimal | number | null | undefined,
): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** AC-2: the four priority settings and the knowledge switch, read once per calculation. */
export function dueSettings(settings: SettingsService): DueSettings {
  return {
    priorityHours: {
      CRITICAL: settings.get('tickets.due_hours_critical'),
      HIGH: settings.get('tickets.due_hours_high'),
      MEDIUM: settings.get('tickets.due_hours_medium'),
      LOW: settings.get('tickets.due_hours_low'),
    },
    knowledgeOn: settings.isModuleOn('knowledge'),
  };
}

/** AC-3: one issue's hours, knowledge base first. */
export function issueHours(
  issue: DueIssueInput,
  stats: Map<string, EntryStats>,
  knowledgeOn: boolean,
): { hours: number; from: IssueHoursFrom; samples: number } {
  if (knowledgeOn && issue.knowledgeEntryId) {
    const entry = stats.get(issue.knowledgeEntryId);
    // typicalHours is already null under knowledge.min_samples (resolveStats)
    if (entry?.typicalHours != null) {
      return {
        hours: entry.typicalHours,
        from: 'KNOWLEDGE',
        samples: entry.hoursSamples,
      };
    }
    if (issue.estimatedHours != null) {
      return { hours: issue.estimatedHours, from: 'ESTIMATE', samples: 0 };
    }
  }
  if (issue.categoryFixHours != null) {
    return { hours: issue.categoryFixHours, from: 'CATEGORY', samples: 0 };
  }
  return { hours: 0, from: 'NONE', samples: 0 };
}

/** Spec 0030, rule steps 1 to 4 (AC-1, AC-3, AC-6). */
export function computeDueAt(
  ticket: { priority: RepairPriority; createdAt: Date },
  issues: DueIssueInput[],
  settings: DueSettings,
  stats: Map<string, EntryStats>,
  now: Date,
): DueResult {
  const priorityHours = settings.priorityHours[ticket.priority];
  const perIssue = issues.map((issue) => ({
    id: issue.id,
    description: issue.description,
    categoryName: issue.categoryName,
    ...issueHours(issue, stats, settings.knowledgeOn),
  }));
  const sum = round2(perIssue.reduce((total, i) => total + i.hours, 0));
  const totalIssueHours = Math.min(sum, MAX_ISSUE_HOURS);
  const issuesWin = totalIssueHours > priorityHours;
  const hours = issuesWin ? totalIssueHours : priorityHours;
  const fromCreate = new Date(
    ticket.createdAt.getTime() + Math.round(hours * HOUR_MS),
  );
  const base = {
    priority: ticket.priority,
    priorityHours,
    issueHours: totalIssueHours,
    issues: perIssue,
  };
  if (fromCreate.getTime() < now.getTime()) {
    return {
      ...base,
      dueAt: new Date(now.getTime() + priorityHours * HOUR_MS),
      source: 'PRIORITY',
      escalated: true,
    };
  }
  return {
    ...base,
    dueAt: fromCreate,
    source: issuesWin ? 'ISSUE_TYPE' : 'PRIORITY',
    escalated: false,
  };
}

const PRIORITY_LABEL: Record<RepairPriority, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

/** "6", "1.5", "0.25": hours without trailing zeros. */
export function hoursText(hours: number): string {
  return String(round2(hours));
}

function prefix(trigger: DueTrigger): string {
  if (typeof trigger === 'object') {
    return 'expedite' in trigger
      ? `Expedite ${trigger.expedite}. `
      : `Back to the automatic date: ${trigger.reset}. `;
  }
  switch (trigger) {
    case 'CREATE':
      return '';
    case 'PRIORITY':
      return 'Priority changed. ';
    case 'ISSUE_ADDED':
      return 'Issue added. ';
    case 'ISSUE_REMOVED':
      return 'Issue removed. ';
    case 'ISSUE_CHANGED':
      return 'Issue changed. ';
    case 'KNOWN_FIX':
      return 'Known fix changed. ';
    case 'REFERRAL':
      return 'Issues added from VMMS. ';
    case 'BACKFILL':
      return 'Due date set by the new rules. ';
  }
}

/**
 * Rule step 5: the audit note and BMS's changeReason. Names categories and counts, never an
 * issue's description (spec 0029 sends BMS no issue text). Cut to 500 characters.
 */
export function dueReason(result: DueResult, trigger: DueTrigger): string {
  const priority = PRIORITY_LABEL[result.priority];
  let rule: string;
  if (result.escalated) {
    rule = `Raised to ${priority} after its time had passed: due ${hoursText(result.priorityHours)} h from now`;
  } else if (result.source === 'ISSUE_TYPE') {
    const parts = result.issues
      .filter((issue) => issue.hours > 0)
      .map((issue) => {
        const name = issue.categoryName ?? 'Other';
        const history =
          issue.from === 'KNOWLEDGE'
            ? ` from ${issue.samples} past repairs`
            : '';
        return `${name} ${hoursText(issue.hours)} h${history}`;
      });
    rule = `Due date from issue times (${hoursText(result.issueHours)} h: ${parts.join(', ')})`;
  } else {
    rule = `Due date from ${priority} priority (${hoursText(result.priorityHours)} h)`;
  }
  return (prefix(trigger) + rule).slice(0, REASON_MAX);
}

/**
 * AC-11: when an open ticket turns Due soon. The window is the smaller of the setting and half
 * its whole time. Null for a closed or cancelled ticket, or one with no date.
 */
export function dueSoonAt(
  ticket: {
    dueAt: Date | null;
    createdAt: Date;
    repairStatus: Parameters<typeof isFinished>[0];
  },
  dueSoonHours: number,
): Date | null {
  if (!ticket.dueAt || isFinished(ticket.repairStatus)) return null;
  const half = (ticket.dueAt.getTime() - ticket.createdAt.getTime()) / 2;
  const window = Math.min(dueSoonHours * HOUR_MS, Math.max(half, 0));
  return new Date(ticket.dueAt.getTime() - Math.round(window));
}

type Tx = Prisma.TransactionClient;

/** The ticket and issue fields the calculator reads, loaded inside the transaction. */
export async function loadDueInputs(
  tx: Tx,
  ticketId: string,
  settings: SettingsService,
) {
  const ticket = await tx.repairTicket.findUniqueOrThrow({
    where: { id: ticketId },
    select: {
      id: true,
      priority: true,
      createdAt: true,
      dueAt: true,
      dueAtSource: true,
      repairStatus: true,
      issues: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          description: true,
          knowledgeEntryId: true,
          category: { select: { name: true, fixHours: true } },
          knowledgeEntry: { select: { estimatedHours: true } },
        },
      },
    },
  });
  const issues: DueIssueInput[] = ticket.issues.map((issue) => ({
    id: issue.id,
    description: issue.description,
    categoryName: issue.category?.name ?? null,
    categoryFixHours: decimalHours(issue.category?.fixHours),
    knowledgeEntryId: issue.knowledgeEntryId,
    estimatedHours: decimalHours(issue.knowledgeEntry?.estimatedHours),
  }));
  const config = dueSettings(settings);
  const entryIds = config.knowledgeOn
    ? [
        ...new Set(
          issues.flatMap((i) =>
            i.knowledgeEntryId ? [i.knowledgeEntryId] : [],
          ),
        ),
      ]
    : [];
  // Archived fixes still count: loadStats reads by id, whatever the entry's status
  const stats = await loadStats(
    tx,
    entryIds,
    settings.get('knowledge.min_samples'),
  );
  return { ticket, issues, config, stats };
}

/** The automatic date a ticket would get now, for the reset dialog's preview (AC-9). */
export async function previewDueAt(
  tx: Tx,
  ticketId: string,
  settings: SettingsService,
  now: Date,
) {
  const { ticket, issues, config, stats } = await loadDueInputs(
    tx,
    ticketId,
    settings,
  );
  return { ticket, result: computeDueAt(ticket, issues, config, stats, now) };
}

export type RecomputeOptions = {
  trigger: DueTrigger;
  actor: RowActor;
  /** The request's now: AC-6 compares with it, and the audit row is stamped with it. */
  now: Date;
  /** The audit row's time when it must sort after the path's own rows (stampedAt). */
  at?: Date;
  /** Create and the referral path queue their own BMS update right after. */
  skipBmsUpdate?: boolean;
  /**
   * Reset and backfill only: work the date out even when the source is MANUAL. Open tickets
   * are still the only ones written.
   */
  includeManual?: boolean;
};

/**
 * AC-5: works an automatic date out again inside the caller's transaction and writes it through
 * setDueAt. Skips a MANUAL date (unless includeManual) and a closed or cancelled ticket (AC-14).
 * Answers whether the date changed.
 */
export async function recomputeDueAt(
  tx: Tx,
  ticketId: string,
  settings: SettingsService,
  options: RecomputeOptions,
): Promise<boolean> {
  const { ticket, issues, config, stats } = await loadDueInputs(
    tx,
    ticketId,
    settings,
  );
  if (isFinished(ticket.repairStatus)) return false;
  if (
    ticket.dueAtSource === 'MANUAL' &&
    ticket.dueAt &&
    !options.includeManual
  ) {
    return false;
  }
  const result = computeDueAt(ticket, issues, config, stats, options.now);
  return setDueAt(
    tx,
    ticket,
    {
      dueAt: result.dueAt,
      source: result.source,
      reason: dueReason(result, options.trigger),
    },
    options.actor,
    options.at ?? options.now,
    { skipBmsUpdate: options.skipBmsUpdate },
  );
}
