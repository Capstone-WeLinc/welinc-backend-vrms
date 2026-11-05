import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { subject } from '@casl/ability';
import { KnowledgeEntryStatus, Prisma, RepairStatus } from '@prisma/client';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import { applyStatusMove } from './apply-status-move';
import {
  Actor,
  type AuditChange,
  AuditEventData,
  auditData,
  issueAddedEvent,
  issueEditedEvent,
  issueRemovedEvent,
  mechanicsChangedEvent,
  stampedAt,
  whoName,
  type TicketDetailValues,
  ticketEditedEvent,
} from './audit-events';
import { AssignMechanicsDto } from './dto/assign-mechanics.dto';
import {
  AddIssueDto,
  EditIssueDto,
  EditTicketDetailsDto,
  SetMechanicsDto,
  TicketEditDto,
} from './dto/edit-ticket.dto';
import { findMove } from './ticket-transitions';
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
  issueDescription,
} from './ticket-inputs';
import { EmbeddingService } from '../ai/embedding.service';
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
    private readonly embeddings: EmbeddingService,
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

  // ── Mechanics (AC-9 to AC-12) ─────────────────────────────────────────────

  // ticket.assign is checked by the route's guard
  async setMechanics(
    id: string,
    dto: SetMechanicsDto,
    user: Actor,
    ability: AppAbility,
  ) {
    const { ticket, note } = await this.loadForEdit(id, dto, ability);
    return this.saveMechanics(
      ticket,
      dto.mechanics.map((m) => m.id),
      note,
      user,
      ability,
    );
  }

  /**
   * POST /:id/assignments, kept as a thin alias so an older web build keeps working: adds the
   * given mechanics to the current list, then saves through the PUT logic.
   */
  async addMechanics(
    id: string,
    dto: AssignMechanicsDto,
    user: Actor,
    ability: AppAbility,
  ) {
    const { ticket, note } = await this.loadForEdit(id, dto, ability);
    const current = ticket.assignments.map((a) => a.mechanicId);
    const added = dto.mechanics.map((m) => m.id);
    if (new Set(added).size !== added.length) {
      throw new BadRequestException('Choose each mechanic only once.');
    }
    return this.saveMechanics(
      ticket,
      [...current, ...added.filter((m) => !current.includes(m))],
      note,
      user,
      ability,
    );
  }

  private async saveMechanics(
    ticket: TicketRow,
    mechanicIds: string[],
    note: string | null,
    user: Actor,
    ability: AppAbility,
  ) {
    // AC-9: each listed once, every one an active in house mechanic, no cap
    if (new Set(mechanicIds).size !== mechanicIds.length) {
      throw new BadRequestException('Choose each mechanic only once.');
    }
    const mechanics = await this.prisma.mechanic.findMany({
      where: { id: { in: mechanicIds }, isActive: true },
      select: { id: true, name: true, authUserId: true },
    });
    if (mechanics.length !== mechanicIds.length) {
      throw new BadRequestException('In house mechanic not found');
    }

    const current = ticket.assignments.map((a) => a.mechanic);
    const removed = current.filter((m) => !mechanicIds.includes(m.id));
    const added = mechanicIds
      .filter((mid) => !current.some((m) => m.id === mid))
      .map((mid) => mechanics.find((m) => m.id === mid)!);

    // AC-11: the verifier never joins the ticket they verified (spec 0014)
    if (
      ticket.verifiedByUserId &&
      added.some((m) => m.authUserId === ticket.verifiedByUserId)
    ) {
      throw new BadRequestException(
        "The person who verified this ticket can't be added to it.",
      );
    }

    // AC-8b: the same list again changes nothing
    if (removed.length === 0 && added.length === 0) {
      return this.repairs.present(ticket, ability);
    }

    // AC-10: M1 when an Open ticket gets its first mechanic, M2 when an Assigned one loses its
    // last. Never looked up on a finished ticket, and no other status ever moves.
    const before = current.length;
    const after = mechanicIds.length;
    const target =
      ticket.repairStatus === RepairStatus.OPEN && before === 0 && after > 0
        ? RepairStatus.ASSIGNED
        : ticket.repairStatus === RepairStatus.ASSIGNED && after === 0
          ? RepairStatus.OPEN
          : null;
    const move = target ? findMove(ticket.repairStatus, target) : null;
    if (move && move.trigger !== 'assignment') {
      throw new Error(`Move ${move.id} is not an assignment move`);
    }
    const statusChange = move
      ? { from: ticket.repairStatus, to: move.to }
      : null;
    const removedEvent =
      removed.length > 0
        ? mechanicsChangedEvent(
            'removed',
            removed.map((m) => m.name),
            move?.id === 'M2' ? statusChange : null,
            note,
          )
        : null;
    const addedEvent =
      added.length > 0
        ? mechanicsChangedEvent(
            'added',
            added.map((m) => m.name),
            move?.id === 'M1' ? statusChange : null,
            note,
          )
        : null;

    const id = ticket.id;
    const now = new Date();
    // Spec 0021, AC-3b: the rows are stamped in write order, removed then added, 1 ms apart, and
    // lastActivityAt is the newest one
    const rowAt = new Map<AuditEventData, Date>();
    [removedEvent, addedEvent]
      .filter((e): e is AuditEventData => !!e)
      .forEach((event, i) => rowAt.set(event, stampedAt(now, i)));
    const activityAt = stampedAt(now, Math.max(rowAt.size - 1, 0));
    const updated = await this.prisma.$transaction(async (tx) => {
      // AC-19: the guarded stamp first
      await stampEdit(tx, ticket, user, now, {}, activityAt);
      if (removed.length > 0) {
        await tx.ticketAssignment.deleteMany({
          where: {
            repairTicketId: id,
            mechanicId: { in: removed.map((m) => m.id) },
          },
        });
      }
      if (added.length > 0) {
        await tx.ticketAssignment.createMany({
          data: added.map((m) => ({
            repairTicketId: id,
            mechanicId: m.id,
            assignedAt: now,
            assignedByUserId: user.sub,
            assignedByName: whoName(user),
          })),
        });
      }
      // AC-12: MECHANIC_UNASSIGNED, then MECHANIC_ASSIGNED, each at its own stamped time. The side
      // that triggered a move is written by applyStatusMove instead of a STATUS_CHANGE row.
      const write = (event: AuditEventData) =>
        tx.auditLog.create({
          data: {
            repairTicketId: id,
            ...auditData(user, event, rowAt.get(event)!),
          },
        });
      if (move) {
        if (removedEvent && move.id !== 'M2') await write(removedEvent);
        const moveEvent = (move.id === 'M2' ? removedEvent : addedEvent)!;
        // The stamp moved updatedAt to now, so the move's own guarded update matches it
        await applyStatusMove(
          tx,
          { ...ticket, updatedAt: now },
          move,
          user,
          null,
          now,
          { audit: moveEvent, auditAt: rowAt.get(moveEvent), activityAt },
        );
        if (addedEvent && move.id !== 'M1') await write(addedEvent);
      } else {
        if (removedEvent) await write(removedEvent);
        if (addedEvent) await write(addedEvent);
      }
      return tx.repairTicket.findUniqueOrThrow({
        where: { id },
        include: ticketInclude,
      });
    });

    this.logger.log(
      `Ticket ${ticket.repairNumber} mechanics: -[${removed.map((m) => m.name).join(', ')}] +[${added.map((m) => m.name).join(', ')}]${move ? ` (${move.id})` : ''} by ${user.email}`,
    );
    return this.repairs.present(updated, ability);
  }

  // ── Issues (AC-14 to AC-17) ───────────────────────────────────────────────

  // ticket.edit is checked by the route's guard
  async addIssue(
    id: string,
    dto: AddIssueDto,
    user: Actor,
    ability: AppAbility,
  ) {
    const { ticket, note } = await this.loadForEdit(id, dto, ability);
    const [category, entry] = await Promise.all([
      this.prisma.issueCategory.findFirst({
        where: { id: dto.categoryId, isActive: true },
      }),
      dto.knowledgeEntryId
        ? this.prisma.knowledgeEntry.findFirst({
            where: {
              id: dto.knowledgeEntryId,
              status: KnowledgeEntryStatus.ACTIVE,
            },
            include: { steps: { orderBy: { position: 'asc' } } },
          })
        : null,
    ]);
    if (!category) {
      throw new BadRequestException(
        'A chosen system is no longer available. Pick another one.',
      );
    }
    if (dto.knowledgeEntryId && !entry) {
      throw new BadRequestException(
        'A chosen common issue is no longer available. Pick another one, or choose Other.',
      );
    }
    const description = issueDescription(
      category.name,
      dto.rootCause,
      dto.description,
      entry?.name,
    );

    const now = new Date();
    const { updated, issueId } = await this.prisma.$transaction(async (tx) => {
      await stampEdit(tx, ticket, user, now);
      // A linked entry's steps are copied, as on create (spec 0007)
      const issue = await tx.repairIssue.create({
        data: {
          repairTicketId: id,
          description,
          categoryId: category.id,
          knowledgeEntryId: entry?.id ?? null,
          ...(entry && {
            steps: {
              create: entry.steps.map((s) => ({
                position: s.position,
                text: s.text,
              })),
            },
          }),
        },
      });
      await tx.auditLog.create({
        data: {
          repairTicketId: id,
          ...auditData(user, issueAddedEvent(issue.id, description, note), now),
        },
      });
      const updated = await tx.repairTicket.findUniqueOrThrow({
        where: { id },
        include: ticketInclude,
      });
      return { updated, issueId: issue.id };
    });

    // Never awaited: embedding must not fail or slow the save (spec 0013, AC-14)
    void this.embeddings.embedIssuesInBackground([issueId]);
    this.logger.log(
      `Ticket ${ticket.repairNumber}: issue added by ${user.email}`,
    );
    return this.repairs.present(updated, ability);
  }

  // ticket.edit is checked by the route's guard
  async editIssue(
    id: string,
    issueId: string,
    dto: EditIssueDto,
    user: Actor,
    ability: AppAbility,
  ) {
    const { ticket, note } = await this.loadForEdit(id, dto, ability);
    const issue = ticket.issues.find((i) => i.id === issueId);
    if (!issue) throw new NotFoundException('Issue not found on this ticket');
    const category = await this.prisma.issueCategory.findFirst({
      where: { id: dto.categoryId, isActive: true },
    });
    if (!category) {
      throw new BadRequestException(
        'A chosen system is no longer available. Pick another one.',
      );
    }
    const description = `[${category.name}] ${dto.text}`;
    // A known fix from another category no longer fits the issue: the link and its copied steps go
    const clearsFix =
      !!issue.knowledgeEntry && issue.knowledgeEntry.categoryId !== category.id;
    const changes: AuditChange[] = [];
    if (description !== issue.description) {
      changes.push({
        field: 'description',
        before: issue.description,
        after: description,
      });
    }
    if (category.id !== issue.categoryId) {
      changes.push({
        field: 'system',
        before: issue.category?.name ?? null,
        after: category.name,
      });
    }
    if (clearsFix) {
      changes.push({
        field: 'knowledgeEntry',
        before: issue.knowledgeEntry!.name,
        after: null,
      });
    }
    // AC-8b: nothing changed, so no audit row and no stamp
    if (changes.length === 0) return this.repairs.present(ticket, ability);

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await stampEdit(tx, ticket, user, now);
      if (clearsFix) {
        // Spec 0023, AC-14: the checklist lock moves before its steps go
        await tx.repairIssue.update({
          where: { id: issueId },
          data: { checklistVersion: { increment: 1 } },
        });
        await tx.repairIssueStep.deleteMany({
          where: { repairIssueId: issueId },
        });
      }
      await tx.repairIssue.update({
        where: { id: issueId },
        data: {
          description,
          categoryId: category.id,
          ...(clearsFix && { knowledgeEntryId: null }),
        },
      });
      await tx.auditLog.create({
        data: {
          repairTicketId: id,
          ...auditData(user, issueEditedEvent(issueId, changes, note), now),
        },
      });
      return tx.repairTicket.findUniqueOrThrow({
        where: { id },
        include: ticketInclude,
      });
    });

    if (description !== issue.description) {
      void this.embeddings.embedIssuesInBackground([issueId]);
    }
    this.logger.log(
      `Ticket ${ticket.repairNumber}: issue ${issueId} edited by ${user.email}`,
    );
    return this.repairs.present(updated, ability);
  }

  // ticket.edit is checked by the route's guard
  async removeIssue(
    id: string,
    issueId: string,
    dto: TicketEditDto,
    user: Actor,
    ability: AppAbility,
  ) {
    const { ticket, note } = await this.loadForEdit(id, dto, ability);
    const issue = ticket.issues.find((i) => i.id === issueId);
    if (!issue) throw new NotFoundException('Issue not found on this ticket');
    // AC-17: a ticket always keeps at least one issue
    if (ticket.issues.length <= 1) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'LAST_ISSUE',
        message: 'Add the right issue first, or reword this one.',
      });
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await stampEdit(tx, ticket, user, now);
      // Steps and the embedding cascade; photos and knowledge suggestions lose the link (SetNull)
      await tx.repairIssue.delete({ where: { id: issueId } });
      await tx.auditLog.create({
        data: {
          repairTicketId: id,
          ...auditData(
            user,
            issueRemovedEvent(
              {
                id: issueId,
                description: issue.description,
                system: issue.category?.name ?? null,
                resolutionNote: issue.resolutionNote,
              },
              note,
            ),
            now,
          ),
        },
      });
      return tx.repairTicket.findUniqueOrThrow({
        where: { id },
        include: ticketInclude,
      });
    });

    this.logger.log(
      `Ticket ${ticket.repairNumber}: issue ${issueId} removed by ${user.email}`,
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
