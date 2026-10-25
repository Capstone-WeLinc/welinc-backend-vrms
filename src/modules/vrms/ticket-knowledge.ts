import { BadRequestException } from '@nestjs/common';
import { Prisma, RepairStatus } from '@prisma/client';

// Spec 0007, AC-27 to AC-31: what a ticket's issues carry from the knowledge base, and the
// "What fixed it" rules on the move to For verification. Pure, so the rules test without a database.

/** Link, relink and unlink only while a ticket is Pending or In progress (State transitions). */
export const LINKABLE_STATUSES: RepairStatus[] = [
  RepairStatus.PENDING,
  RepairStatus.IN_PROGRESS,
];

export const STALE_TICKET =
  'This ticket has been updated by another user. Please reload the page to see the latest changes.';

/** The issue relations formatTicket reads. */
export const issueInclude = {
  orderBy: { createdAt: 'asc' },
  include: {
    category: { select: { name: true } },
    knowledgeEntry: {
      select: {
        id: true,
        name: true,
        status: true,
        safetyNotes: true,
        estimatedHours: true,
        parts: { orderBy: { position: 'asc' }, select: { name: true } },
      },
    },
    steps: { orderBy: { position: 'asc' } },
  },
} satisfies Prisma.RepairTicket$issuesArgs;

type IssueRow = Prisma.RepairIssueGetPayload<{
  include: (typeof issueInclude)['include'];
}>;

const num = (value: Prisma.Decimal | null) =>
  value == null ? null : Number(value);

/** One issue as formatTicket sends it. typicalHours is the entry's median, null under MIN_SAMPLES. */
export function formatIssue(
  issue: IssueRow,
  typicalHours: Map<string, number | null>,
) {
  const entry = issue.knowledgeEntry;
  return {
    id: issue.id,
    description: issue.description,
    categoryId: issue.categoryId,
    categoryName: issue.category?.name ?? null,
    knowledgeEntry: entry
      ? {
          id: entry.id,
          name: entry.name,
          status: entry.status,
          safetyNotes: entry.safetyNotes,
          parts: entry.parts.map((p) => p.name),
          typicalHours: typicalHours.get(entry.id) ?? null,
          estimatedHours: num(entry.estimatedHours),
        }
      : null,
    steps: issue.steps.map((s) => ({
      id: s.id,
      position: s.position,
      text: s.text,
      checkedAt: s.checkedAt,
      checkedByEmail: s.checkedByEmail,
    })),
    resolutionNote: issue.resolutionNote,
    hoursSpent: num(issue.hoursSpent),
    followedKnownFix: issue.followedKnownFix,
    resolvedAt: issue.resolvedAt,
  };
}

export type ResolutionInput = {
  issueId: string;
  resolutionNote?: string;
  hoursSpent?: number;
  followedKnownFix?: boolean;
};

type TicketIssue = {
  id: string;
  description: string;
  knowledgeEntryId: string | null;
};

const short = (text: string) =>
  text.length > 60 ? `${text.slice(0, 57)}...` : text;

/**
 * AC-31: moving In progress to For verification needs one resolution per issue, and a 5 to 500
 * character note for every unlinked issue. Returns the resolutions by issue id.
 */
export function checkResolutions(
  issues: TicketIssue[],
  resolutions: ResolutionInput[] | undefined,
): Map<string, ResolutionInput> {
  const byId = new Map((resolutions ?? []).map((r) => [r.issueId, r]));
  const onTicket = new Set(issues.map((i) => i.id));
  if ([...byId.keys()].some((id) => !onTicket.has(id))) {
    throw new BadRequestException(
      'A resolution names an issue that is not on this ticket.',
    );
  }

  const missing = issues.filter((i) => !byId.has(i.id));
  if (missing.length > 0) {
    throw new BadRequestException(
      `Add what fixed each issue. Missing: ${missing.map((i) => short(i.description)).join('; ')}`,
    );
  }

  const noNote = issues.filter((i) => {
    const note = byId.get(i.id)?.resolutionNote?.trim() ?? '';
    return !i.knowledgeEntryId && (note.length < 5 || note.length > 500);
  });
  if (noNote.length > 0) {
    throw new BadRequestException(
      `Add what fixed it (5 to 500 characters) for: ${noNote.map((i) => short(i.description)).join('; ')}`,
    );
  }
  return byId;
}

/** The fields one resolution writes onto its issue. */
export function resolutionData(
  resolution: ResolutionInput,
  linked: boolean,
  now: Date,
) {
  const note = resolution.resolutionNote?.trim();
  return {
    resolutionNote: note ? note : null,
    hoursSpent: resolution.hoursSpent ?? null,
    followedKnownFix: linked ? (resolution.followedKnownFix ?? true) : null,
    resolvedAt: now,
  };
}
