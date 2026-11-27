import { Injectable } from '@nestjs/common';
import { SuggestionStatus } from '@prisma/client';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import { readableTickets } from './ticket-access';
import {
  isInRoster,
  viewAllowed,
  viewWhere,
  type RepairView,
  type ViewCaller,
} from './repair-views';

/** `GET /vrms/nav/counts` (spec 0027, AC-5): only the counts of sub pages the caller can see. */
export type NavCounts = Partial<
  Record<Exclude<RepairView, 'done'> | 'suggestions', number>
>;

/**
 * Which counts the caller's sidebar shows: the ticket_view_all sub pages, or the caller's own
 * three (Done has no count), mirroring web-vrms's `getNavSections`.
 */
function countedViews(caller: ViewCaller): Exclude<RepairView, 'done'>[] {
  if (caller.ability.can('ticket.view_all', 'Permission')) {
    return caller.inRoster ? ['open', 'signoff', 'mine'] : ['open', 'signoff'];
  }
  return caller.ability.can('ticket.view', 'Permission')
    ? ['active', 'sentBack']
    : [];
}

@Injectable()
export class NavCountsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Each ticket count is `count(where)` with the very where `GET /vrms/repairs?view=` uses
   * (`readableTickets` around `viewWhere`), so it always equals that list's total. They run in
   * one transaction, plus one count for suggestions. A user with no VRMS keys gets `{}`.
   */
  async counts(sub: string, ability: AppAbility): Promise<NavCounts> {
    const caller: ViewCaller = {
      sub,
      ability,
      inRoster: await isInRoster(this.prisma, sub),
    };
    const scope = readableTickets(ability);
    const views = scope
      ? countedViews(caller).filter((view) => viewAllowed(view, caller))
      : [];
    const suggestions = ability.can('knowledge.edit', 'Permission');

    const results = await this.prisma.$transaction([
      ...views.map((view) =>
        this.prisma.repairTicket.count({
          where: { AND: [scope!, viewWhere(view, sub)] },
        }),
      ),
      ...(suggestions
        ? [
            this.prisma.knowledgeSuggestion.count({
              where: { status: SuggestionStatus.OPEN },
            }),
          ]
        : []),
    ]);

    const counts: NavCounts = {};
    views.forEach((view, index) => {
      counts[view] = results[index];
    });
    if (suggestions) counts.suggestions = results[views.length];
    return counts;
  }
}
