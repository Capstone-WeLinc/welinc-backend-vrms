import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../shared/prisma.service';
import type { SettingsService } from '../../settings/settings.service';
import { systemActor } from './audit-events';
import { recomputeDueAt } from './due-dates';
import { OPEN_STATUSES } from './ticket-statuses';

// Spec 0030, AC-13: `npm run due:backfill` gives every open ticket with no due date an automatic
// one, through recomputeDueAt and so setDueAt (an audit row and a BMS update each). 50 tickets per
// batch, one transaction per ticket with its row lock, the VRMS system actor. A ticket that got a
// date in the meantime is skipped, so a second run changes nothing.

export const BACKFILL_BATCH = 50;

export type BackfillResult = { checked: number; written: number };

export async function backfillDueDates(
  prisma: PrismaService,
  settings: SettingsService,
  log: (line: string) => void = () => undefined,
): Promise<BackfillResult> {
  let checked = 0;
  let written = 0;
  let after: string | undefined;
  for (;;) {
    const batch = await prisma.repairTicket.findMany({
      where: {
        dueAt: null,
        repairStatus: { in: OPEN_STATUSES },
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BACKFILL_BATCH,
      select: { id: true },
    });
    if (batch.length === 0) break;
    for (const { id } of batch) {
      checked++;
      const changed = await prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ due_at: Date | null }[]>(Prisma.sql`
          SELECT due_at FROM repair_tickets WHERE id = ${id}::uuid FOR UPDATE`);
        if (!row || row.due_at !== null) return false;
        // A source with no date counts as automatic (includeManual), and closed tickets are
        // still skipped by recomputeDueAt
        return recomputeDueAt(tx, id, settings, {
          trigger: 'BACKFILL',
          actor: systemActor('VRMS'),
          now: new Date(),
          includeManual: true,
        });
      });
      if (changed) written++;
    }
    after = batch[batch.length - 1].id;
    log(`Checked ${checked} tickets, set ${written} due dates.`);
  }
  return { checked, written };
}
