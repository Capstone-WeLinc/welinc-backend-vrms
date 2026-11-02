import {
  BadRequestException,
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
import {
  activeDriver,
  corporationName,
  driverForLicense,
  type DriverRow,
} from './ticket-inputs';
import { correctedOdometerProblem, ticketOdometerBounds } from './odometer';
import { SettingsService } from '../../settings/settings.service';

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
    private readonly settings: SettingsService,
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

    // AC-4: at most one of an existing driver or a new one
    if (dto.driverId && dto.newDriver) {
      throw new BadRequestException('Choose or add a driver.');
    }
    const pickedDriver =
      dto.driverId && dto.driverId !== ticket.driverId
        ? await activeDriver(this.prisma, dto.driverId)
        : null;

    const data: Prisma.RepairTicketUpdateManyMutationInput = {};
    const before = detailValues(ticket);
    const after = { ...before };

    // AC-5: between the truck's tickets before and after this one, with the jump confirm
    if (
      dto.odometerReading !== undefined &&
      dto.odometerReading !== ticket.odometer
    ) {
      const problem = correctedOdometerProblem(
        dto.odometerReading,
        await ticketOdometerBounds(this.prisma, ticket),
        this.settings.get('tickets.odometer_jump_warn_km'),
        dto.confirmOdometerJump === true,
      );
      if (problem) throw problem;
      data.odometer = dto.odometerReading;
      after.odometer = dto.odometerReading;
    }

    if (dto.priority !== undefined) {
      data.priority = dto.priority;
      after.priority = dto.priority;
    }

    // AC-7: an omitted accountType keeps the current one; ONLINE clears the corporation
    const account = await this.accountChange(ticket, dto);
    if (account) {
      data.accountType = account.accountType;
      data.corporation = account.corporation;
      after.accountType = account.accountType;
      after.corporation = account.corporation;
    }

    if (pickedDriver) after.driver = driverLabel(pickedDriver);
    // AC-8b: nothing changed, so no audit row and no stamp (a new driver is always a change)
    if (!dto.newDriver && !ticketEditedEvent(before, after).changes.length) {
      return this.repairs.present(ticket, ability);
    }

    const now = new Date();
    const { updated, event } = await this.prisma.$transaction(async (tx) => {
      // AC-19: the guarded stamp is the first write, before any driver row is touched
      await stampEdit(tx, ticket, user, now, data);
      let driver: DriverRow | null = pickedDriver;
      if (dto.newDriver) {
        driver = await driverForLicense(tx, this.prisma, dto.newDriver);
      }
      if (driver) {
        await tx.repairTicket.update({
          where: { id },
          data: { driverId: driver.id, updatedAt: now },
        });
        after.driver = driverLabel(driver);
      }
      // One row listing only the fields that changed (AC-8)
      const event = ticketEditedEvent(before, after, note);
      await tx.auditLog.create({
        data: { repairTicketId: id, ...auditData(user, event, now) },
      });
      const updated = await tx.repairTicket.findUniqueOrThrow({
        where: { id },
        include: ticketInclude,
      });
      return { updated, event };
    });

    this.logger.log(
      `Ticket ${ticket.repairNumber} edited (${event.changes.map((c) => c.field).join(', ')}) by ${user.email}`,
    );
    return this.repairs.present(updated, ability);
  }

  /**
   * AC-7: the account type and corporation snapshot a details save writes, or null when the body
   * asks for neither. A corporationId on a ticket that is (or becomes) Online is a 400.
   */
  private async accountChange(
    ticket: TicketRow,
    dto: EditTicketDetailsDto,
  ): Promise<{
    accountType: 'ONLINE' | 'CORPORATE';
    corporation: string | null;
  } | null> {
    const type = dto.accountType ?? ticket.accountType;
    if (dto.accountType === undefined && dto.corporationId === undefined) {
      return null;
    }
    if (type !== 'CORPORATE') {
      if (dto.corporationId) {
        throw new BadRequestException(
          'A corporation goes with a Corporate account only.',
        );
      }
      return { accountType: 'ONLINE', corporation: null };
    }
    return {
      accountType: 'CORPORATE',
      corporation: await corporationName(this.prisma, dto.corporationId),
    };
  }
}
