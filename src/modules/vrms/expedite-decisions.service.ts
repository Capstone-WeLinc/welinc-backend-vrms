import { subject } from '@casl/ability';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import { queueExpediteAnswer } from '../integrations/bms/expedite-answers';
import { setDueAt } from '../integrations/bms/set-due-at';
import {
  type Actor,
  auditData,
  expediteDecidedEvent,
  stampedAt,
  whoName,
} from './audit-events';
import type {
  AcceptExpediteDto,
  DeclineExpediteDto,
  ExpediteRequestListResponse,
} from './dto/expedite-decisions.dto';
import { expediteView, requestSelect } from './expedite-views';
import { RepairsService, ticketInclude } from './repairs.service';
import { STALE_TICKET } from './ticket-knowledge';
import { stampEdit } from './ticket-edits';

// Spec 0029 (child 0003), AC-18 and AC-19: the waiting BMS expedite requests, and a person's
// answer to one. Routes check integration.respond. Locks go ticket first, then the request, the
// same order as intake and the auto decline on close, so they can't deadlock.

const STALE = { statusCode: 409, code: 'STALE', message: STALE_TICKET };

const alreadyDecided = () =>
  new ConflictException({
    statusCode: 409,
    code: 'EXPEDITE_ALREADY_DECIDED',
    message: 'This request was already answered.',
  });

const LIST_LIMIT = 50;

@Injectable()
export class ExpediteDecisionsService {
  private readonly logger = new Logger(ExpediteDecisionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repairs: RepairsService,
  ) {}

  /** AC-18: every waiting request, oldest first, for the Admin dashboard. */
  async listWaiting(): Promise<ExpediteRequestListResponse> {
    const [rows, waitingCount] = await Promise.all([
      this.prisma.expediteRequest.findMany({
        where: { status: 'WAITING' },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        take: LIST_LIMIT,
        select: requestSelect,
      }),
      this.prisma.expediteRequest.count({ where: { status: 'WAITING' } }),
    ]);
    return { items: rows.map(expediteView), waitingCount };
  }

  /**
   * AC-19: raises the ticket's priority through spec 0019's edit path (the guarded stamp first,
   * one TICKET_EDITED row), sets the due date through setDueAt when one is given, and queues
   * the answer, all in one transaction.
   */
  async accept(
    id: string,
    dto: AcceptExpediteDto,
    user: Actor,
    ability: AppAbility,
  ) {
    const request = await this.waiting(id);
    const ticket = await this.readableTicket(request.repairTicketId, ability);
    if (ticket.updatedAt.toISOString() !== dto.updatedAt) {
      throw new ConflictException(STALE);
    }
    const note = `Expedite ${request.jobOrderNumber}`;
    const dueAt = dto.dueAt ? new Date(dto.dueAt) : ticket.dueAt;
    const now = new Date();
    // EXPEDITE_ACCEPTED, then the priority row, then the due date row, 1 ms apart
    const lastAt = stampedAt(now, 2);
    await this.prisma.$transaction(async (tx) => {
      try {
        await stampEdit(
          tx,
          ticket,
          user,
          now,
          { priority: dto.priority },
          lastAt,
        );
      } catch (error) {
        if (error instanceof ConflictException)
          throw new ConflictException(STALE);
        throw error;
      }
      await this.lockWaiting(tx, id);
      await tx.auditLog.create({
        data: {
          repairTicketId: ticket.id,
          ...auditData(
            user,
            expediteDecidedEvent('ACCEPTED', request.jobOrderNumber, null),
            now,
          ),
        },
      });
      // Spec 0019's TICKET_EDITED row, with the one field this answer changes
      if (ticket.priority !== dto.priority) {
        await tx.auditLog.create({
          data: {
            repairTicketId: ticket.id,
            ...auditData(
              user,
              {
                action: 'TICKET_EDITED',
                changes: [
                  {
                    field: 'priority',
                    before: ticket.priority,
                    after: dto.priority,
                  },
                ],
                note,
              },
              stampedAt(now, 1),
            ),
          },
        });
      }
      if (dto.dueAt) {
        await setDueAt(
          tx,
          ticket,
          { dueAt, source: 'MANUAL', reason: note },
          user,
          stampedAt(now, 2),
        );
      }
      await tx.expediteRequest.update({
        where: { id },
        data: {
          status: 'ACCEPTED',
          newPriority: dto.priority,
          newDueAt: dto.dueAt ? dueAt : null,
          decidedByUserId: user.sub,
          decidedByName: whoName(user),
          decidedAt: now,
        },
      });
      await queueExpediteAnswer(tx, {
        requestId: id,
        repairTicketId: ticket.id,
        repairTicketNumber: ticket.repairNumber,
        decision: 'ACCEPTED',
        reason: null,
        priority: dto.priority,
        expectedReturnAt: dueAt,
      });
    });
    this.logger.log(
      `Expedite ${request.jobOrderNumber} on ${ticket.repairNumber} accepted by ${user.email}`,
    );
    return this.presented(ticket.id, ability);
  }

  /** AC-19: declined with a reason, and BMS is told in the same transaction. */
  async decline(
    id: string,
    dto: DeclineExpediteDto,
    user: Actor,
    ability: AppAbility,
  ) {
    const request = await this.waiting(id);
    const ticket = await this.readableTicket(request.repairTicketId, ability);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // The ticket's row lock first. Raw SQL so the ticket's updatedAt stays: a decline edits
      // nothing on it, and moving it would make every open edit dialog stale
      await tx.$executeRaw`
        UPDATE repair_tickets SET last_activity_at = ${now}
        WHERE id = ${ticket.id}::uuid
      `;
      await this.lockWaiting(tx, id);
      await tx.expediteRequest.update({
        where: { id },
        data: {
          status: 'DECLINED',
          responseReason: dto.reason,
          decidedByUserId: user.sub,
          decidedByName: whoName(user),
          decidedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          repairTicketId: ticket.id,
          ...auditData(
            user,
            expediteDecidedEvent(
              'DECLINED',
              request.jobOrderNumber,
              dto.reason,
            ),
            now,
          ),
        },
      });
      await queueExpediteAnswer(tx, {
        requestId: id,
        repairTicketId: ticket.id,
        repairTicketNumber: ticket.repairNumber,
        decision: 'DECLINED',
        reason: dto.reason,
        priority: null,
        expectedReturnAt: null,
      });
    });
    this.logger.log(
      `Expedite ${request.jobOrderNumber} on ${ticket.repairNumber} declined by ${user.email}`,
    );
    return this.presented(ticket.id, ability);
  }

  /** The checks outside the transaction: 404, then 409 when already answered. */
  private async waiting(id: string) {
    const request = await this.prisma.expediteRequest.findUnique({
      where: { id },
      select: { status: true, repairTicketId: true, jobOrderNumber: true },
    });
    if (!request) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'EXPEDITE_NOT_FOUND',
        message: 'This expedite request was not found.',
      });
    }
    if (request.status !== 'WAITING') throw alreadyDecided();
    return request;
  }

  /** The same check under the row lock, so two Admins can't both answer it. */
  private async lockWaiting(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM expedite_requests WHERE id = ${id}::uuid FOR UPDATE
    `;
    if (rows[0]?.status !== 'WAITING') throw alreadyDecided();
  }

  private async readableTicket(id: string, ability: AppAbility) {
    const ticket = await this.prisma.repairTicket.findUniqueOrThrow({
      where: { id },
      include: ticketInclude,
    });
    if (!ability.can('read', subject('RepairTicket', ticket))) {
      throw new ForbiddenException(
        'You are not assigned to this repair ticket',
      );
    }
    return ticket;
  }

  private async presented(id: string, ability: AppAbility) {
    const updated = await this.prisma.repairTicket.findUniqueOrThrow({
      where: { id },
      include: ticketInclude,
    });
    return this.repairs.present(updated, ability);
  }
}
