import { subject } from '@casl/ability';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import { EmbeddingService } from '../ai/embedding.service';
import { queueVmmsRepairEvent } from '../integrations/vmms-repair-events';
import {
  CHANGE_REASON,
  queueBmsRepairUpdate,
} from '../integrations/bms/bms-repair-updates';
import { queueReferralRejected } from '../integrations/vmms-referral-events';
import { ReferralsService } from '../integrations/referrals/referrals.service';
import {
  type Actor,
  auditData,
  issueAddedEvent,
  referralAddedEvent,
  referralRejectedEvent,
  stampedAt,
  whoName,
} from './audit-events';
import type {
  AddReferralToTicketDto,
  RejectReferralDto,
} from './dto/referral-decisions.dto';
import {
  RepairsService,
  referralAlreadyDecided,
  ticketInclude,
} from './repairs.service';
import { STALE_TICKET } from './ticket-knowledge';
import { stampEdit } from './ticket-edits';
import { OPEN_STATUSES } from './ticket-statuses';

// Spec 0029 (child 0002), AC-9 to AC-11: the two decisions on a VMMS referral besides opening a
// ticket from it (that one goes through RepairsService.create). The route checks
// integration.respond; each decision locks the referral and checks it is still waiting.

const STALE = {
  statusCode: 409,
  code: 'STALE',
  message: STALE_TICKET,
};

@Injectable()
export class ReferralDecisionsService {
  private readonly logger = new Logger(ReferralDecisionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repairs: RepairsService,
    private readonly referrals: ReferralsService,
    private readonly embeddings: EmbeddingService,
  ) {}

  /**
   * AC-9: the findings become issues on the truck's open ticket, through spec 0019's issue add
   * (the guarded stamp first, one ISSUE_ADDED row each), and the referral is linked, in one
   * transaction that also queues the repair event to VMMS.
   */
  async addToTicket(
    id: string,
    dto: AddReferralToTicketDto,
    user: Actor,
    ability: AppAbility,
  ) {
    const referral = await this.waiting(id);
    const ticket = await this.prisma.repairTicket.findFirst({
      where: {
        vehicleId: referral.vehicleId,
        repairStatus: { in: OPEN_STATUSES },
      },
      include: ticketInclude,
    });
    if (!ticket) {
      throw new ConflictException({
        statusCode: 409,
        code: 'NO_OPEN_TICKET',
        message: 'This truck has no open ticket now. Open a ticket instead.',
      });
    }
    if (!ability.can('read', subject('RepairTicket', ticket))) {
      throw new ForbiddenException(
        'You are not assigned to this repair ticket',
      );
    }
    if (ticket.updatedAt.toISOString() !== dto.updatedAt) {
      throw new ConflictException(STALE);
    }
    const categoryIds = [...new Set(dto.issues.map((i) => i.categoryId))];
    const categories = await this.prisma.issueCategory.findMany({
      where: { id: { in: categoryIds }, isActive: true },
    });
    if (categories.length !== categoryIds.length) {
      throw new BadRequestException(
        'A chosen system is no longer available. Pick another one.',
      );
    }
    const nameOf = new Map(categories.map((c) => [c.id, c.name]));

    const now = new Date();
    // REFERRAL_ADDED, then one ISSUE_ADDED per line, 1 ms apart (spec 0021, AC-3b)
    const lastAt = stampedAt(now, dto.issues.length);
    const { issueIds } = await this.prisma.$transaction(async (tx) => {
      await this.lockWaiting(tx, id);
      // Spec 0019, AC-19: the guarded stamp first; it also takes the ticket's row lock, so the
      // repair event below queues in commit order (AC-13)
      try {
        await stampEdit(tx, ticket, user, now, {}, lastAt);
      } catch (error) {
        if (error instanceof ConflictException)
          throw new ConflictException(STALE);
        throw error;
      }
      const linked = await tx.referral.findMany({
        where: {
          repairTicketId: ticket.id,
          status: { in: ['OPENED_TICKET', 'ADDED_TO_TICKET'] },
        },
        select: { maintenanceScheduleId: true },
      });
      await tx.auditLog.create({
        data: {
          repairTicketId: ticket.id,
          ...auditData(user, referralAddedEvent(referral.workOrderNumber), now),
        },
      });
      const issueIds: string[] = [];
      for (const [i, line] of dto.issues.entries()) {
        const description = `[${nameOf.get(line.categoryId)!}] ${line.description}`;
        const issue = await tx.repairIssue.create({
          data: {
            repairTicketId: ticket.id,
            description,
            categoryId: line.categoryId,
          },
        });
        issueIds.push(issue.id);
        await tx.auditLog.create({
          data: {
            repairTicketId: ticket.id,
            ...auditData(
              user,
              issueAddedEvent(issue.id, description, null),
              stampedAt(now, i + 1),
            ),
          },
        });
      }
      await tx.referral.update({
        where: { id },
        data: {
          status: 'ADDED_TO_TICKET',
          repairTicketId: ticket.id,
          decidedByUserId: user.sub,
          decidedByName: whoName(user),
          decidedAt: now,
        },
      });
      // VMMS refuses a LINKS_UPDATED that adds no schedule (ask 5): a second referral for a
      // schedule already on the ticket goes as STATUS_UPDATED with the new referral id
      const newSchedule = !linked.some(
        (r) => r.maintenanceScheduleId === referral.maintenanceScheduleId,
      );
      await queueVmmsRepairEvent(
        tx,
        ticket.id,
        newSchedule ? 'LINKS_UPDATED' : 'STATUS_UPDATED',
      );
      // Child 0003, AC-17: the new issues can change the reason BMS shows (their categories)
      await queueBmsRepairUpdate(
        tx,
        ticket.id,
        CHANGE_REASON.referralAdded(referral.workOrderNumber),
      );
      return { issueIds };
    });

    // Never awaited: embedding must not fail or slow the save (spec 0013, AC-14)
    void this.embeddings.embedIssuesInBackground(issueIds);
    this.logger.log(
      `Referral ${referral.workOrderNumber} added to ${ticket.repairNumber} by ${user.email}`,
    );
    const updated = await this.prisma.repairTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      include: ticketInclude,
    });
    return this.repairs.present(updated, ability);
  }

  /** AC-10: sent back with a reason, and VMMS is told in the same transaction. */
  async reject(id: string, dto: RejectReferralDto, user: Actor) {
    const referral = await this.waiting(id);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.lockWaiting(tx, id);
      await tx.referral.update({
        where: { id },
        data: {
          status: 'REJECTED',
          rejectionReason: dto.reason,
          decidedByUserId: user.sub,
          decidedByName: whoName(user),
          decidedAt: now,
        },
      });
      await tx.auditLog.create({
        data: {
          repairTicketId: null,
          ...auditData(
            user,
            referralRejectedEvent(referral.workOrderNumber, dto.reason),
            now,
          ),
        },
      });
      await queueReferralRejected(tx, { id, rejectionReason: dto.reason });
    });
    this.logger.log(
      `Referral ${referral.workOrderNumber} rejected by ${user.email}`,
    );
    return this.referrals.detail(id);
  }

  /** The checks outside the transaction: 404, then 409 when already decided. */
  private async waiting(id: string) {
    const referral = await this.prisma.referral.findUnique({
      where: { id },
      select: {
        status: true,
        vehicleId: true,
        workOrderNumber: true,
        maintenanceScheduleId: true,
      },
    });
    if (!referral) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'REFERRAL_NOT_FOUND',
        message: 'This referral was not found.',
      });
    }
    if (referral.status !== 'WAITING') throw referralAlreadyDecided();
    return referral;
  }

  /** The same check under the row lock, so two Admins can't both decide it (AC-8, AC-10). */
  private async lockWaiting(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM referrals WHERE id = ${id}::uuid FOR UPDATE
    `;
    if (rows[0]?.status !== 'WAITING') throw referralAlreadyDecided();
  }
}
