import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { subject } from '@casl/ability';
import { Prisma, StepOrigin } from '@prisma/client';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import { Actor, auditData, stampedAt } from './audit-events';
import {
  CHECKLIST_STATUS_MESSAGE,
  checklistDiff,
  checklistEvents,
  cleanSteps,
  hasChanges,
  idProblem,
  STALE_CHECKLIST,
  type StoredStep,
} from './checklist-edits';
import { SaveChecklistDto } from './dto/save-checklist.dto';
import { RepairsService, ticketInclude } from './repairs.service';
import { LINKABLE_STATUSES } from './ticket-knowledge';

/** Thrown inside the transaction when the save changes nothing, so the version bump rolls back. */
class NothingChanged extends Error {}

/** Assignments with the mechanic's welinc-auth id, so the `mine` condition can match (AC-1). */
const ownerAssignments = {
  include: { mechanic: { select: { authUserId: true } } },
} satisfies Prisma.RepairTicket$assignmentsArgs;

/**
 * Spec 0023: a ticket issue's checklist, saved as one ordered list. Locks on the issue's own
 * checklistVersion, never the ticket's updatedAt, so a save never makes another ticket edit stale.
 */
@Injectable()
export class ChecklistEditsService {
  private readonly logger = new Logger(ChecklistEditsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repairs: RepairsService,
  ) {}

  async save(
    id: string,
    issueId: string,
    dto: SaveChecklistDto,
    user: Actor,
    ability: AppAbility,
  ) {
    // AC-5: the limits need no database, so they answer before anything is locked
    const { steps, fieldErrors } = cleanSteps(dto.steps);
    if (fieldErrors.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        message: fieldErrors[0].message,
        fieldErrors,
      });
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // (1) AC-6: the guarded bump takes the issue's row lock; a relink waits on it, or beat it
        const { count } = await tx.repairIssue.updateMany({
          where: {
            id: issueId,
            repairTicketId: id,
            checklistVersion: dto.checklistVersion,
          },
          data: { checklistVersion: dto.checklistVersion + 1 },
        });
        if (count === 0) {
          const exists = await tx.repairIssue.count({
            where: { id: issueId, repairTicketId: id },
          });
          if (exists === 0) {
            throw new NotFoundException('Issue not found on this ticket');
          }
          throw new ConflictException(STALE_CHECKLIST);
        }

        // (2) AC-3: access and status after the lock, so a save never lands after a move out
        const ticket = await tx.repairTicket.findUniqueOrThrow({
          where: { id },
          include: { assignments: ownerAssignments },
        });
        if (!ability.can('editChecklist', subject('RepairTicket', ticket))) {
          throw new ForbiddenException(
            "You can't edit the checklist on this ticket.",
          );
        }
        if (!LINKABLE_STATUSES.includes(ticket.repairStatus)) {
          throw new BadRequestException(CHECKLIST_STATUS_MESSAGE);
        }

        // (3) AC-8: a tick arriving now waits for this save, and a tick made earlier is kept
        const stored = await tx.$queryRaw<StoredStep[]>`
          SELECT id, position, text, checked_at AS "checkedAt",
                 checked_by_email AS "checkedByEmail", origin::text AS origin,
                 edited_at AS "editedAt"
          FROM repair_issue_steps
          WHERE repair_issue_id = ${issueId}::uuid
          ORDER BY position
          FOR UPDATE`;
        const problem = idProblem(stored, steps);
        if (problem) throw new BadRequestException(problem);

        const diff = checklistDiff(stored, steps);
        // AC-11: nothing to write, and the bump rolls back with the transaction
        if (!hasChanges(diff)) throw new NothingChanged();
        const now = new Date();

        // (4) removed steps go
        if (diff.removed.length > 0) {
          await tx.repairIssueStep.deleteMany({
            where: { id: { in: diff.removed.map((s) => s.id) } },
          });
        }
        // (5) every kept step out of the way, so (6) never meets the unique position
        if (diff.kept.length > 0) {
          await tx.repairIssueStep.updateMany({
            where: { id: { in: diff.kept.map((k) => k.stored.id) } },
            data: { position: { increment: 1000 } },
          });
        }
        // (6) each kept step to its place, with its text, tick and editedAt in one write
        for (const k of diff.kept) {
          await tx.repairIssueStep.update({
            where: { id: k.stored.id },
            data: {
              position: k.position,
              ...(k.reworded && {
                text: k.text,
                checkedAt: null,
                checkedByEmail: null,
                // An ADDED step never gets editedAt: it is already marked as this ticket's
                ...(k.stored.origin === StepOrigin.KNOWN_FIX && {
                  editedAt: now,
                }),
              }),
            },
          });
        }
        // (7) new steps, with their ids known up front for the audit rows
        const addedIds = diff.added.map(() => randomUUID());
        if (diff.added.length > 0) {
          await tx.repairIssueStep.createMany({
            data: diff.added.map((a, i) => ({
              id: addedIds[i],
              repairIssueId: issueId,
              position: a.position,
              text: a.text,
              origin: StepOrigin.ADDED,
            })),
          });
        }

        // (8) AC-10: one row per changed step, 1 ms apart in the order removed, reworded, moved, added
        const events = checklistEvents(diff, addedIds, issueId);
        await tx.auditLog.createMany({
          data: events.map((event, i) => ({
            repairTicketId: id,
            ...auditData(user, event, stampedAt(now, i)),
          })),
        });
        // (9) updatedAt passed as stored, so @updatedAt leaves the ticket's lock alone
        await tx.repairTicket.update({
          where: { id },
          data: {
            lastActivityAt: stampedAt(now, events.length - 1),
            updatedAt: ticket.updatedAt,
          },
        });
        this.logger.log(
          `Checklist on ${ticket.repairNumber} issue ${issueId} saved by ${user.email}: ${events.length} changes`,
        );
      });
    } catch (err) {
      // AC-11: a save that changes nothing answers 200 with the ticket as it is
      if (!(err instanceof NothingChanged)) throw err;
    }

    const updated = await this.prisma.repairTicket.findUniqueOrThrow({
      where: { id },
      include: ticketInclude,
    });
    return this.repairs.present(updated, ability);
  }
}
