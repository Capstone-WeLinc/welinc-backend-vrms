import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type ExpediteStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import {
  auditData,
  expediteRequestedEvent,
  systemActor,
} from '../../vrms/audit-events';
import { OPEN_STATUSES } from '../../vrms/ticket-statuses';
import { payloadHash } from '../referrals/referral-intake';
import type { ExpediteRequestDto } from './bms-integration.dto';

export type ExpediteAnswer = {
  requestId: string;
  status: ExpediteStatus;
  repairTicketNumber: string;
  duplicate: boolean;
};

/**
 * Spec 0029 (child 0003), AC-18 and AC-25: stores a BMS expedite request as `WAITING` against the
 * truck's open ticket. The request id is the key: a resend with the same body answers the stored
 * answer, a changed body is refused, and a truck with no open repair answers 404.
 */
@Injectable()
export class ExpediteIntakeService {
  private readonly logger = new Logger(ExpediteIntakeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async receive(
    dto: ExpediteRequestDto,
    rawBody: unknown,
    now = new Date(),
  ): Promise<ExpediteAnswer> {
    const hash = payloadHash(rawBody);
    const seen = await this.existing(dto.requestId, hash);
    if (seen) return seen;

    try {
      const answer = await this.prisma.$transaction(async (tx) => {
        // The open ticket, row locked, so a close running now either ends first (no open
        // ticket: 404) or waits and then declines this request (AC-19)
        const [ticket] = await tx.$queryRaw<
          { id: string; repairNumber: string }[]
        >`
          SELECT t.id, t.repair_number AS "repairNumber"
          FROM repair_tickets t
          JOIN vehicles v ON v.id = t.vehicle_id
          WHERE v.vmms_vehicle_id = ${dto.vmmsVehicleId}::uuid
            AND t.repair_status::text = ANY(${OPEN_STATUSES as string[]})
          ORDER BY t.created_at
          LIMIT 1
          FOR UPDATE OF t
        `;
        if (!ticket) throw noOpenRepair();
        const jobOrderNumber = dto.jobOrderNumber.trim();
        const reason = dto.reason.trim();
        await tx.expediteRequest.create({
          data: {
            id: dto.requestId,
            repairTicketId: ticket.id,
            jobOrderNumber,
            reason,
            neededBy: dto.neededBy
              ? new Date(`${dto.neededBy}T00:00:00Z`)
              : null,
            receivedAt: now,
            payloadHash: hash,
          },
        });
        // A system's change to a ticket names the system (AC-25); it is not a person's activity,
        // so lastActivityAt stays
        await tx.auditLog.create({
          data: {
            repairTicketId: ticket.id,
            ...auditData(
              systemActor('BMS'),
              expediteRequestedEvent(jobOrderNumber, reason),
              now,
            ),
          },
        });
        return {
          requestId: dto.requestId,
          status: 'WAITING' as const,
          repairTicketNumber: ticket.repairNumber,
          duplicate: false,
        };
      });
      this.logger.log(
        `Expedite ${dto.requestId} (${dto.jobOrderNumber}) received for ${answer.repairTicketNumber}`,
      );
      return answer;
    } catch (error) {
      // Two copies of one request raced; the first won, so answer as a resend
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.existing(dto.requestId, hash);
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async existing(
    requestId: string,
    hash: string,
  ): Promise<ExpediteAnswer | null> {
    const row = await this.prisma.expediteRequest.findUnique({
      where: { id: requestId },
      select: {
        status: true,
        payloadHash: true,
        repairTicket: { select: { repairNumber: true } },
      },
    });
    if (!row) return null;
    if (row.payloadHash !== hash) {
      throw new ConflictException({
        statusCode: 409,
        code: 'REQUEST_ID_REUSED',
        message: 'This request id was already received with a different body.',
      });
    }
    return {
      requestId,
      status: row.status,
      repairTicketNumber: row.repairTicket.repairNumber,
      duplicate: true,
    };
  }
}

const noOpenRepair = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'NO_OPEN_REPAIR',
    message: 'This truck has no open repair in VRMS. Don’t retry.',
  });
