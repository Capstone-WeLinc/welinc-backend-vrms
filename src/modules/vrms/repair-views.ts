import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, RepairStatus } from '@prisma/client';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import type { PrismaService } from '../../shared/prisma.service';
import { OPEN_STATUSES } from './ticket-statuses';

/*
  VRMS spec 0027, AC-2, AC-4 and AC-5: the sidebar's sub pages are `view` presets of the repair
  list, and each sub page's count is that list's total. Both read `viewWhere`, so a count can
  never disagree with the list it counts. A view only ever narrows what the caller may read:
  the list still applies `readableTickets` around it.
*/

export const REPAIR_VIEWS = [
  'open',
  'signoff',
  'mine',
  'active',
  'sentBack',
  'done',
] as const;
export type RepairView = (typeof REPAIR_VIEWS)[number];

/** Spec 0027, AC-2: "In progress" for a mechanic is Assigned, In progress or On hold. */
const ACTIVE_STATUSES: RepairStatus[] = [
  RepairStatus.ASSIGNED,
  RepairStatus.IN_PROGRESS,
  RepairStatus.ON_HOLD,
];

export interface ViewCaller {
  /** The welinc-auth user id (`req.user.sub`). */
  sub: string;
  ability: AppAbility;
  /** An active, assignable roster member (suite spec 0018 child 0002, AC-33). */
  inRoster: boolean;
}

/** The tickets the caller is assigned to: the same condition as the ability's `mine`. */
export function assignedTo(sub: string): Prisma.RepairTicketWhereInput {
  return { assignments: { some: { mechanic: { is: { authUserId: sub } } } } };
}

/** Who may use each view (spec 0027, Count and view rules). */
export function viewAllowed(view: RepairView, caller: ViewCaller): boolean {
  const can = (key: 'ticket.view_all' | 'ticket.view') =>
    caller.ability.can(key, 'Permission');
  switch (view) {
    case 'open':
    case 'signoff':
      return can('ticket.view_all');
    case 'mine':
      return caller.inRoster;
    case 'active':
    case 'sentBack':
    case 'done':
      return can('ticket.view');
  }
}

/** The tickets of one view (AC-2). */
export function viewWhere(
  view: RepairView,
  sub: string,
): Prisma.RepairTicketWhereInput {
  switch (view) {
    case 'open':
      return { repairStatus: { in: OPEN_STATUSES } };
    case 'signoff':
      // For verification, minus the caller's own: nobody verifies their own work (spec 0014)
      return {
        repairStatus: RepairStatus.FOR_VERIFICATION,
        assignments: { none: { mechanic: { is: { authUserId: sub } } } },
      };
    case 'mine':
      return {
        AND: [{ repairStatus: { in: OPEN_STATUSES } }, assignedTo(sub)],
      };
    case 'active':
      return {
        AND: [{ repairStatus: { in: ACTIVE_STATUSES } }, assignedTo(sub)],
      };
    case 'sentBack':
      return {
        AND: [
          { repairStatus: RepairStatus.IN_PROGRESS, sentBackAt: { not: null } },
          assignedTo(sub),
        ],
      };
    case 'done':
      // Closed only: a cancelled ticket was never done
      return { AND: [{ repairStatus: RepairStatus.CLOSED }, assignedTo(sub)] };
  }
}

/**
 * AC-4: `view` from the query. An unknown one answers 400 `VALIDATION_FAILED`, and one the
 * caller can't use answers 403 (for example `mine` outside the roster).
 */
export function readView(raw: string, caller: ViewCaller): RepairView {
  const view = REPAIR_VIEWS.find((candidate) => candidate === raw);
  if (!view) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: `view must be one of ${REPAIR_VIEWS.join(', ')}`,
    });
  }
  if (!viewAllowed(view, caller)) {
    throw new ForbiddenException('You can’t open this list.');
  }
  return view;
}

/**
 * `inRoster` on `/vrms/permissions/me` and the `mine` rule: the caller's `Mechanic` row exists,
 * is active and assignable (suite spec 0018 child 0002, AC-33).
 */
export async function isInRoster(
  prisma: PrismaService,
  sub: string,
): Promise<boolean> {
  const row = await prisma.mechanic.findFirst({
    where: { authUserId: sub, isActive: true, assignable: true },
    select: { id: true },
  });
  return row !== null;
}
