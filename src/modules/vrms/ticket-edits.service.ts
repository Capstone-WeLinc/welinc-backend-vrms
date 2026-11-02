import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { subject } from '@casl/ability';
import { Prisma } from '@prisma/client';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import {
  Actor,
  auditData,
  type TicketDetailValues,
  ticketEditedEvent,
} from './audit-events';
import { EditTicketDetailsDto, TicketEditDto } from './dto/edit-ticket.dto';
import {
  RepairsService,
  ticketInclude,
  type TicketRow,
} from './repairs.service';
import { assertFresh, editNote, stampEdit } from './ticket-edits';

// Spec 0019: fix a ticket after create, one section at a time. Each save is one transaction whose
// first write is the guarded stamp (AC-19), and answers with the ticket as GET /:id returns it.

/** AC-8: the driver as the audit row names them. */
function driverLabel(driver: { name: string; licenseNumber: string }) {
  return `${driver.name} (${driver.licenseNumber})`;
}

function detailValues(ticket: TicketRow): TicketDetailValues {
  return {
    driver: driverLabel(ticket.driver),
    odometer: ticket.odometer,
    priority: ticket.priority,
    accountType: ticket.accountType,
    corporation: ticket.corporation,
  };
}

@Injectable()
export class TicketEditsService {
  private readonly logger = new Logger(TicketEditsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repairs: RepairsService,
  ) {}

  /**
   * The checks every edit starts with, in this order: 404, the caller may read the ticket (403),
   * the stale check (409), then the lock and reason rules (400). Returns the ticket and the audit
   * note (the reason on an unlocked closed ticket, else null).
   */
  private async loadForEdit(
    id: string,
    dto: TicketEditDto,
    ability: AppAbility,
  ): Promise<{ ticket: TicketRow; note: string | null }> {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: ticketInclude,
    });
    if (!ticket) throw new NotFoundException('Repair ticket not found');
    if (!ability.can('read', subject('RepairTicket', ticket))) {
      throw new ForbiddenException(
        'You are not assigned to this repair ticket',
      );
    }
    assertFresh(ticket, dto.lastUpdatedAt);
    return { ticket, note: editNote(ticket, dto.reason) };
  }

  // ── Details (AC-4 to AC-8) ────────────────────────────────────────────────

  // ticket.edit is checked by the route's guard
  async editDetails(
    id: string,
    dto: EditTicketDetailsDto,
    user: Actor,
    ability: AppAbility,
  ) {
    const { ticket, note } = await this.loadForEdit(id, dto, ability);

    const data: Prisma.RepairTicketUpdateManyMutationInput = {};
    const before = detailValues(ticket);
    const after = { ...before };
    if (dto.priority !== undefined) {
      data.priority = dto.priority;
      after.priority = dto.priority;
    }

    const event = ticketEditedEvent(before, after, note);
    // AC-8b: nothing changed, so no audit row and no stamp
    if (event.changes.length === 0)
      return this.repairs.present(ticket, ability);

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await stampEdit(tx, ticket, user, now, data);
      await tx.auditLog.create({
        data: { repairTicketId: id, ...auditData(user, event, now) },
      });
      return tx.repairTicket.findUniqueOrThrow({
        where: { id },
        include: ticketInclude,
      });
    });

    this.logger.log(
      `Ticket ${ticket.repairNumber} edited (${event.changes.map((c) => c.field).join(', ')}) by ${user.email}`,
    );
    return this.repairs.present(updated, ability);
  }
}
