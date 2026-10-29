import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { subject } from '@casl/ability';
import { permittedFieldsOf } from '@casl/ability/extra';
import { accessibleBy } from '@casl/prisma';
import {
  KnowledgeEntryStatus,
  Prisma,
  RepairStatus,
  VehicleStatus,
} from '@prisma/client';
import { UserRole } from '../../auth/roles';
import {
  type AppAbility,
  COST_FIELDS,
} from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import {
  AuditEvent,
  auditData,
  costEvent,
  createdEvent,
  decodeCursor,
  encodeCursor,
  knowledgeLinkEvent,
  olderThan,
  statusEvent,
  toAuditEvent,
  unlockEvent,
  whoName,
} from './audit-events';
import {
  FINISHED_STATUSES,
  isFinished,
  OPEN_STATUSES,
  STATUS_LABELS,
} from './ticket-statuses';
import { AuditEventsQueryDto } from './dto/audit-events-query.dto';
import { CreateRepairDto } from './dto/create-repair.dto';
import { FindRepairsQueryDto } from './dto/find-repairs-query.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { UpdateRepairStatusDto } from './dto/update-repair-status.dto';
import { UpdateCostsDto } from './dto/update-costs.dto';
import { UnlockTicketDto } from './dto/unlock-ticket.dto';
import {
  CheckIssueStepDto,
  LinkIssueKnowledgeDto,
} from './dto/link-issue-knowledge.dto';
import { loadStats } from '../knowledge/knowledge-stats';
import {
  checkResolutions,
  formatIssue,
  issueInclude,
  LINKABLE_STATUSES,
  resolutionData,
  STALE_TICKET,
} from './ticket-knowledge';

// ── Types ─────────────────────────────────────────────────────────────────────

type JwtUser = {
  sub: string;
  email: string;
  name: string;
  roles: { role: UserRole; system: string }[];
  system: string;
};

// Mechanics and chief mechanics may only start work and send it for verification; closing and
// cancelling stay Admin only until feature 16 replaces these moves (spec 0010, AC-4)
const MECHANIC_ALLOWED_TRANSITIONS: RepairStatus[] = [
  RepairStatus.IN_PROGRESS,
  RepairStatus.FOR_VERIFICATION,
];

// Today's forward moves on the v2 names; any open status may also move to CANCELLED
const FORWARD_MOVES: Partial<Record<RepairStatus, RepairStatus>> = {
  [RepairStatus.ASSIGNED]: RepairStatus.IN_PROGRESS,
  [RepairStatus.IN_PROGRESS]: RepairStatus.FOR_VERIFICATION,
  [RepairStatus.FOR_VERIFICATION]: RepairStatus.CLOSED,
};

const AUDIT_PAGE_SIZE = 50;

const LIST_PAGE_SIZE = 20;

// ── Helper ────────────────────────────────────────────────────────────────────

/** Validated `from` (inclusive) and `to` (exclusive) instants; `from >= to` is a 400. */
function parseRange(from: string | undefined, to: string | undefined) {
  const range = {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  };
  if (range.from && range.to && range.from >= range.to) {
    throw new BadRequestException('"from" must be before "to"');
  }
  return range;
}

/** The tickets the caller may read, as a where; null when they may read none (spec 0011, AC-10). */
function readableTickets(
  ability: AppAbility,
): Prisma.RepairTicketWhereInput | null {
  // accessibleBy's no access marker fails a query, so answer empty before reaching Prisma
  if (!ability.can('read', 'RepairTicket')) return null;
  return accessibleBy(ability, 'read').ofType('RepairTicket');
}

type CostField = (typeof COST_FIELDS)[number];

/** The cost fields the caller may read; without ticket.costs.view, none (spec 0011, AC-11). */
function visibleCostFields(ability: AppAbility): ReadonlySet<CostField> {
  const permitted = permittedFieldsOf(ability, 'read', 'RepairTicket', {
    fieldsFrom: (rule) => rule.fields ?? [...COST_FIELDS],
  });
  return new Set(COST_FIELDS.filter((field) => permitted.includes(field)));
}

/**
 * How the caller may change this ticket's status, steps and known fixes (spec 0011, AC-12).
 * ticket.administer acts on any ticket with every valid move and wins over ticket.work, which
 * acts on the caller's own tickets with the mechanic moves only. Anyone else gets a 403.
 */
function workAccess(
  ability: AppAbility,
  ticket: OwnedTicket,
): 'administer' | 'work' {
  const target = subject('RepairTicket', ticket);
  if (ability.can('administer', target)) return 'administer';
  if (ability.can('work', target)) return 'work';
  throw new ForbiddenException('You are not assigned to this repair ticket');
}

/** Assignments loaded with the mechanic's welinc-auth id, so ownership conditions can match. */
const ownerInclude = {
  include: { mechanic: { select: { authUserId: true } } },
} satisfies Prisma.RepairTicket$assignmentsArgs;

type OwnedTicket = Prisma.RepairTicketGetPayload<{
  include: { assignments: typeof ownerInclude };
}>;

function generateRepairNumber(): string {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const suffix = Math.random().toString(36).slice(-4).toUpperCase();
  return `REP-${date}-${suffix}`;
}

// ── Service ───────────────────────────────────────────────────────────────────

/** The relations a ticket is loaded with, for formatTicket. */
const ticketInclude = {
  vehicle: { select: { plateNumber: true, model: true, status: true } },
  driver: { select: { name: true, licenseNumber: true, isVerified: true } },
  garage: { select: { name: true } },
  issues: issueInclude,
  assignments: {
    orderBy: { assignedAt: 'asc' },
    select: {
      mechanicId: true,
      // authUserId so the ability's ownership condition can match a loaded ticket
      mechanic: { select: { id: true, name: true, authUserId: true } },
    },
  },
  repairParts: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.RepairTicketInclude;

type TicketRow = Prisma.RepairTicketGetPayload<{
  include: typeof ticketInclude;
}>;

@Injectable()
export class RepairsService {
  private readonly logger = new Logger(RepairsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Create repair ticket ─────────────────────────────────────────────────

  async create(dto: CreateRepairDto, user: JwtUser, ability: AppAbility) {
    const repairNumber = dto.repairNumber ?? generateRepairNumber();

    // Strict lookup: Vehicle
    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        plateNumber: dto.vehiclePlate,
        isActive: true,
        deletedAt: null,
      },
    });
    if (!vehicle) {
      throw new BadRequestException(
        `Vehicle with plate number "${dto.vehiclePlate}" not found`,
      );
    }

    // Strict lookup: Garage
    const garage = await this.prisma.garage.findFirst({
      where: {
        name: dto.garageLocation,
        isActive: true,
        deletedAt: null,
      },
    });
    if (!garage) {
      throw new BadRequestException(
        `Garage location "${dto.garageLocation}" not found`,
      );
    }

    // Spec 0007, AC-26: each issue's category must be active, and a picked entry Active.
    // Checked before any write, so a 400 leaves nothing half done.
    const { categories, entries } = await this.issueSources(dto);

    // Mechanics come by id and must be active (spec 0009, AC-27; spec 0010, AC-12). Checked here,
    // before any write, so a 400 leaves nothing half done.
    const mechanicIds = [...new Set(dto.mechanics.map((m) => m.id))];
    const activeCount = await this.prisma.mechanic.count({
      where: { id: { in: mechanicIds }, isActive: true },
    });
    if (activeCount !== mechanicIds.length) {
      throw new BadRequestException('In house mechanic not found');
    }

    // Lookup/Create: Drivers
    const licenseKey = dto.driverName
      .toLowerCase()
      .replace(/\s+/g, '-')
      .substring(0, 50);
    const existingDriver = await this.prisma.driver.findUnique({
      where: { licenseNumber: licenseKey },
    });
    const driver = existingDriver
      ? await this.prisma.driver.update({
          where: { id: existingDriver.id },
          data: {
            name: dto.driverName,
            isActive: true,
            deletedAt: null,
          },
        })
      : await this.prisma.driver.create({
          data: {
            name: dto.driverName,
            licenseNumber: licenseKey,
            isVerified: false,
          },
        });

    // Set vehicle status to UNDER_REPAIR
    await this.prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { status: VehicleStatus.UNDER_REPAIR },
    });

    // The DTO requires a mechanic, so a new ticket starts Assigned (spec 0010, AC-3)
    const now = new Date();
    const reporter = { userId: user.sub, name: whoName(user) };
    const ticket = await this.prisma.repairTicket.create({
      data: {
        repairNumber,
        vehicleId: vehicle.id,
        driverId: driver.id,
        garageId: garage.id,
        odometer: dto.odometerReading,
        repairStatus: RepairStatus.ASSIGNED,
        priority: dto.priority,
        reportedByUserId: reporter.userId,
        reportedByName: reporter.name,
        lastActivityAt: now,
        // Linked issues get a copy of the entry's steps (the CREATED row covers the link, no KNOWLEDGE_LINK)
        issues: {
          create: dto.issues.map((issue) => {
            const entry = issue.knowledgeEntryId
              ? entries.get(issue.knowledgeEntryId)
              : undefined;
            return {
              description: `[${categories.get(issue.categoryId)!.name}] ${issue.rootCause}: ${issue.description}`,
              categoryId: issue.categoryId,
              knowledgeEntryId: entry?.id ?? null,
              ...(entry
                ? {
                    steps: {
                      create: entry.steps.map((step) => ({
                        position: step.position,
                        text: step.text,
                      })),
                    },
                  }
                : {}),
            };
          }),
        },
        assignments: {
          create: mechanicIds.map((mechanicId) => ({
            mechanicId,
            assignedAt: now,
            assignedByUserId: reporter.userId,
            assignedByName: reporter.name,
          })),
        },
        // Nested so the ticket and its CREATED row are saved together or not at all
        auditLogs: { create: auditData(user, createdEvent(), now) },
      },
      include: ticketInclude,
    });

    this.logger.log(`Repair ticket created — ${repairNumber} by ${user.email}`);
    // Auto-embed new issues into pgvector for AI Knowledge Base (fire-and-forget)
    this.autoEmbedIssues(ticket).catch(() => {});
    return this.present(ticket, ability);
  }

  /** The categories and entries the new issues point at; 400 when one is missing or not active. */
  private async issueSources(dto: CreateRepairDto) {
    const categoryIds = [...new Set(dto.issues.map((i) => i.categoryId))];
    const entryIds = [
      ...new Set(
        dto.issues.flatMap((i) =>
          i.knowledgeEntryId ? [i.knowledgeEntryId] : [],
        ),
      ),
    ];
    const [categoryRows, entryRows] = await Promise.all([
      this.prisma.issueCategory.findMany({
        where: { id: { in: categoryIds }, isActive: true },
      }),
      this.prisma.knowledgeEntry.findMany({
        where: { id: { in: entryIds }, status: KnowledgeEntryStatus.ACTIVE },
        include: { steps: { orderBy: { position: 'asc' } } },
      }),
    ]);
    if (categoryRows.length !== categoryIds.length) {
      throw new BadRequestException(
        'A chosen system is no longer available. Pick another one.',
      );
    }
    if (entryRows.length !== entryIds.length) {
      throw new BadRequestException(
        'A chosen common issue is no longer available. Pick another one, or choose Other.',
      );
    }
    return {
      categories: new Map(categoryRows.map((c) => [c.id, c])),
      entries: new Map(entryRows.map((e) => [e.id, e])),
    };
  }

  private async autoEmbedIssues(ticket: TicketRow): Promise<void> {
    const AI_SERVICE =
      process.env.AI_SERVICE_URL || 'http://vrms-analytics-ai:8020';
    for (const issue of ticket.issues ?? []) {
      try {
        await fetch(`${AI_SERVICE}/ai/embed-issue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issue_id: issue.id,
            ticket_id: ticket.id,
            description: issue.description,
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        this.logger.warn(`Auto-embed failed for issue ${issue.id}: ${e}`);
      }
    }
  }

  // ── List repair tickets ──────────────────────────────────────────────────

  async findAll(query: FindRepairsQueryDto, ability: AppAbility) {
    const { search, status, garageId, overdue, mechanicId } = query;
    const scope = readableTickets(ability);
    if (!scope) return { data: [], total: 0 };

    const where: Prisma.RepairTicketWhereInput = {
      repairStatus: status ?? { in: OPEN_STATUSES },
    };

    if (search) {
      where.OR = [
        { repairNumber: { contains: search, mode: 'insensitive' } },
        { vehicle: { plateNumber: { contains: search, mode: 'insensitive' } } },
        { driver: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (garageId) where.garageId = garageId;

    // A filter inside the caller's scope, never a way around it
    if (mechanicId) where.assignments = { some: { mechanicId } };

    // The scope goes first; overdue only ever matches open tickets, whatever status was asked for
    where.AND = [
      scope,
      ...(overdue
        ? [
            { repairStatus: { in: OPEN_STATUSES } },
            { dueAt: { lt: new Date() } },
          ]
        : []),
    ];

    // Neither page nor limit: every row, as the dashboard expects. One of them: the other defaults
    const paged = query.page !== undefined || query.limit !== undefined;
    const page = query.page ?? 1;
    const limit = query.limit ?? LIST_PAGE_SIZE;

    const [total, tickets] = await Promise.all([
      this.prisma.repairTicket.count({ where }),
      this.prisma.repairTicket.findMany({
        where,
        include: ticketInclude,
        // Most urgent first; id last so pages never repeat or skip a row
        orderBy: [
          { dueAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        ...(paged && { skip: (page - 1) * limit, take: limit }),
      }),
    ]);

    return {
      data: tickets.map((t) => this.formatTicket(t, ability)),
      total,
    };
  }

  // ── Repair history (closed + cancelled) ──────────────────────────────────

  async findHistory(query: HistoryQueryDto, ability: AppAbility) {
    const { search, status, garageId, page, limit } = query;
    const { from, to } = parseRange(query.from, query.to);
    const hideCosts = !visibleCostFields(ability).has('totalCost');
    const scope = readableTickets(ability);
    if (!scope) {
      return {
        data: [],
        total: 0,
        summary: { finished: 0, closed: 0, cancelled: 0, spend: null },
      };
    }

    // One where for rows, count and summary, so a tile never disagrees with the list
    const where: Prisma.RepairTicketWhereInput = {
      AND: [scope],
      repairStatus: status ?? { in: FINISHED_STATUSES },
    };

    if (search) {
      where.OR = [
        { repairNumber: { contains: search, mode: 'insensitive' } },
        { vehicle: { plateNumber: { contains: search, mode: 'insensitive' } } },
        { driver: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (garageId) where.garageId = garageId;
    if (from || to)
      where.closedAt = { ...(from && { gte: from }), ...(to && { lt: to }) };

    const [tickets, groups] = await Promise.all([
      this.prisma.repairTicket.findMany({
        where,
        select: {
          id: true,
          repairNumber: true,
          repairStatus: true,
          createdAt: true,
          updatedAt: true,
          closedAt: true,
          cancellationReason: true,
          isUnlocked: true,
          totalCost: true,
          vehicle: { select: { plateNumber: true, model: true } },
          driver: { select: { name: true } },
          garage: { select: { name: true } },
        },
        orderBy: [
          { closedAt: { sort: 'desc', nulls: 'last' } },
          { id: 'desc' },
        ],
        ...(page !== undefined &&
          limit !== undefined && { skip: (page - 1) * limit, take: limit }),
      }),
      this.prisma.repairTicket.groupBy({
        by: ['repairStatus'],
        where,
        _count: { _all: true },
        _sum: { totalCost: true },
      }),
    ]);

    const closedGroup = groups.find(
      (g) => g.repairStatus === RepairStatus.CLOSED,
    );
    const closed = closedGroup?._count._all ?? 0;
    const cancelled =
      groups.find((g) => g.repairStatus === RepairStatus.CANCELLED)?._count
        ._all ?? 0;

    const data = tickets.map((t) => {
      const row = {
        id: t.id,
        repairNumber: t.repairNumber,
        status: t.repairStatus,
        vehiclePlate: t.vehicle.plateNumber,
        vehicleModel: t.vehicle.model,
        driverName: t.driver.name,
        garageLocation: t.garage.name,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        closedAt: t.closedAt?.toISOString() ?? null,
        cancellationReason: t.cancellationReason,
        isUnlocked: t.isUnlocked,
      };
      return {
        ...row,
        totalCost:
          hideCosts || t.totalCost == null ? null : Number(t.totalCost),
      };
    });

    return {
      data,
      total: closed + cancelled,
      summary: {
        finished: closed + cancelled,
        closed,
        cancelled,
        // An aggregate of costs, so it follows the same key
        spend: hideCosts ? null : Number(closedGroup?._sum.totalCost ?? 0),
      },
    };
  }

  // ── Single repair ticket ─────────────────────────────────────────────────

  async findOne(id: string, ability: AppAbility) {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: ticketInclude,
    });

    if (!ticket) throw new NotFoundException('Repair ticket not found');

    // ticket.view reads only assigned tickets; ticket.view_all reads every one
    if (!ability.can('read', subject('RepairTicket', ticket))) {
      throw new ForbiddenException(
        'You are not assigned to this repair ticket',
      );
    }

    return this.present(ticket, ability);
  }

  // ── Update repair status ─────────────────────────────────────────────────

  async updateStatus(
    id: string,
    dto: UpdateRepairStatusDto,
    user: JwtUser,
    ability: AppAbility,
  ) {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: { assignments: ownerInclude, vehicle: true, issues: true },
    });

    if (!ticket) throw new NotFoundException('Repair ticket not found');

    if (
      dto.lastUpdatedAt &&
      ticket.updatedAt.toISOString() !== dto.lastUpdatedAt
    ) {
      throw new ConflictException(
        'This ticket has been updated by another user. Please reload the page to see the latest changes.',
      );
    }

    // Today's forward moves on the v2 names, plus cancel from any open status (spec 0010, AC-4)
    const currentStatus = ticket.repairStatus;
    const nextStatus = dto.status;
    const statusChanged = nextStatus !== currentStatus;

    // Finished lock: only bypassed if an Admin has explicitly unlocked the ticket
    if (isFinished(currentStatus) && !ticket.isUnlocked) {
      throw new BadRequestException(
        'Closed or Cancelled repair tickets are locked and cannot be edited. An Admin must unlock this ticket first.',
      );
    }

    if (statusChanged) {
      const isValidTransition =
        nextStatus === RepairStatus.CANCELLED
          ? OPEN_STATUSES.includes(currentStatus)
          : FORWARD_MOVES[currentStatus] === nextStatus;
      if (!isValidTransition) {
        throw new BadRequestException(
          `Cannot change status from '${STATUS_LABELS[currentStatus]}' to '${STATUS_LABELS[nextStatus]}'. Tickets must progress in order: Assigned ➔ In progress ➔ For verification ➔ Closed.`,
        );
      }
    }

    // ticket.work: own tickets and the mechanic moves; closing and cancelling need administer
    if (workAccess(ability, ticket) === 'work') {
      if (!MECHANIC_ALLOWED_TRANSITIONS.includes(dto.status)) {
        throw new ForbiddenException(
          `Mechanics cannot change status to '${STATUS_LABELS[dto.status]}'. Allowed: ${MECHANIC_ALLOWED_TRANSITIONS.map((s) => STATUS_LABELS[s]).join(', ')}.`,
        );
      }
    }

    // Cancellation requires a reason
    if (
      dto.status === RepairStatus.CANCELLED &&
      !dto.cancellationReason?.trim()
    ) {
      throw new BadRequestException('A cancellation reason is required');
    }

    // Spec 0007, AC-31: "What fixed it" for every issue on the way to For verification.
    // Other moves ignore resolutions.
    const sendsForVerification =
      currentStatus === RepairStatus.IN_PROGRESS &&
      nextStatus === RepairStatus.FOR_VERIFICATION;
    const resolutions = sendsForVerification
      ? checkResolutions(ticket.issues, dto.resolutions)
      : null;
    // One clock reading for the audit row, lastActivityAt and the close fields (AC-10)
    const now = new Date();

    // Build update data
    const updateData: Prisma.RepairTicketUpdateInput = {
      repairStatus: dto.status,
      // Re-lock ticket after any edit (if it was unlocked)
      isUnlocked: false,
    };

    if (dto.cancellationReason) {
      updateData.cancellationReason = dto.cancellationReason.trim();
    }

    if (dto.remarks?.trim()) {
      updateData.remarks = dto.remarks.trim();
    }

    // Cost fields sent without ticket.costs.edit are ignored (AC-11)
    if (ability.can('editCosts', subject('RepairTicket', ticket))) {
      if (dto.partsCost !== undefined) updateData.partsCost = dto.partsCost;
      if (dto.laborCost !== undefined) updateData.laborCost = dto.laborCost;
      if (dto.partsCost !== undefined || dto.laborCost !== undefined) {
        const parts = dto.partsCost ?? Number(ticket.partsCost ?? 0);
        const labor = dto.laborCost ?? Number(ticket.laborCost ?? 0);
        updateData.totalCost = parts + labor;
      }
    }

    if (statusChanged) {
      // Only an audited action moves lastActivityAt; an unlocked save with no move writes no row
      updateData.lastActivityAt = now;
      // closedAt is the close time: set only on a real move into a finished status,
      // so saving an unlocked finished ticket never re-dates it
      if (isFinished(nextStatus)) updateData.closedAt = now;
      // Whoever closes the ticket verified it (Admin today); cancelling records no verifier
      if (nextStatus === RepairStatus.CLOSED) {
        updateData.verifiedByUserId = user.sub;
        updateData.verifiedByName = whoName(user);
        updateData.verifiedAt = now;
      }
    }

    // When closing or cancelling, revert vehicle status
    if (isFinished(dto.status)) {
      await this.prisma.vehicle.update({
        where: { id: ticket.vehicleId },
        data: { status: VehicleStatus.AVAILABLE },
      });
    }

    // On close, sync odometer reading back to the master Vehicle record
    // (only if the ticket's reading is higher than the current stored value)
    if (dto.status === RepairStatus.CLOSED) {
      const currentVehicle = await this.prisma.vehicle.findUnique({
        where: { id: ticket.vehicleId },
        select: { odometer: true },
      });
      if (currentVehicle && ticket.odometer > currentVehicle.odometer) {
        await this.prisma.vehicle.update({
          where: { id: ticket.vehicleId },
          data: { odometer: ticket.odometer },
        });
        this.logger.log(
          `Odometer synced for vehicle ${ticket.vehicleId}: ${currentVehicle.odometer} → ${ticket.odometer} km`,
        );
      }
    }

    // Write a status audit row only when the status actually changed
    const [updated] = await this.prisma.$transaction([
      this.prisma.repairTicket.update({
        where: { id },
        data: {
          ...updateData,
          // Nested, so the issues are saved before this update reads them back (AC-31)
          ...(resolutions
            ? {
                issues: {
                  update: ticket.issues.map((issue) => ({
                    where: { id: issue.id },
                    data: resolutionData(
                      resolutions.get(issue.id)!,
                      !!issue.knowledgeEntryId,
                      now,
                    ),
                  })),
                },
              }
            : {}),
        },
        include: ticketInclude,
      }),
      ...(statusChanged
        ? [
            this.prisma.auditLog.create({
              data: {
                repairTicketId: id,
                ...auditData(
                  user,
                  statusEvent(
                    currentStatus,
                    nextStatus,
                    nextStatus === RepairStatus.CANCELLED
                      ? dto.cancellationReason
                      : dto.remarks,
                  ),
                  now,
                ),
              },
            }),
          ]
        : []),
    ]);

    this.logger.log(
      `Repair ticket ${ticket.repairNumber} status updated to ${dto.status} by ${user.email}`,
    );

    return this.present(updated, ability);
  }

  // ── Known fix on an issue (spec 0007, AC-27 to AC-29) ───────────────────

  /**
   * Link, relink or unlink one issue's knowledge entry. The checklist is replaced by a copy of the
   * new entry's steps, with a KNOWLEDGE_LINK audit row and the ticket's updatedAt touched, in one
   * transaction.
   */
  async linkKnowledge(
    id: string,
    issueId: string,
    dto: LinkIssueKnowledgeDto,
    user: JwtUser,
    ability: AppAbility,
  ) {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: {
        assignments: ownerInclude,
        issues: { include: { knowledgeEntry: { select: { name: true } } } },
      },
    });
    if (!ticket) throw new NotFoundException('Repair ticket not found');
    workAccess(ability, ticket);
    const issue = ticket.issues.find((i) => i.id === issueId);
    if (!issue) throw new NotFoundException('Issue not found on this ticket');
    if (!LINKABLE_STATUSES.includes(ticket.repairStatus)) {
      throw new BadRequestException(
        'A known fix can only be changed while the ticket is Assigned or In progress.',
      );
    }
    if (ticket.updatedAt.toISOString() !== dto.lastUpdatedAt) {
      throw new ConflictException(STALE_TICKET);
    }

    const entry = dto.knowledgeEntryId
      ? await this.prisma.knowledgeEntry.findFirst({
          where: {
            id: dto.knowledgeEntryId,
            status: KnowledgeEntryStatus.ACTIVE,
          },
          include: { steps: { orderBy: { position: 'asc' } } },
        })
      : null;
    if (dto.knowledgeEntryId && !entry) {
      throw new BadRequestException(
        'This known fix is no longer available. Pick another one.',
      );
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // The stale check again inside the transaction: only the loaded updatedAt may move on
      const { count } = await tx.repairTicket.updateMany({
        where: { id, updatedAt: ticket.updatedAt },
        data: { updatedAt: now, lastActivityAt: now },
      });
      if (count === 0) throw new ConflictException(STALE_TICKET);

      await tx.repairIssueStep.deleteMany({
        where: { repairIssueId: issueId },
      });
      await tx.repairIssue.update({
        where: { id: issueId },
        data: {
          knowledgeEntryId: entry?.id ?? null,
          ...(entry && !issue.categoryId
            ? { categoryId: entry.categoryId }
            : {}),
          steps: entry
            ? {
                create: entry.steps.map((s) => ({
                  position: s.position,
                  text: s.text,
                })),
              }
            : undefined,
        },
      });
      await tx.auditLog.create({
        data: {
          repairTicketId: id,
          ...auditData(
            user,
            knowledgeLinkEvent(
              issueId,
              issue.knowledgeEntry?.name ?? null,
              entry?.name ?? null,
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
      `Known fix on ${ticket.repairNumber} issue ${issueId} set to ${entry?.name ?? 'none'} by ${user.email}`,
    );
    return this.present(updated, ability);
  }

  /** Tick or untick one copied step while In progress. Never touches the ticket's updatedAt (AC-28). */
  async checkStep(
    id: string,
    issueId: string,
    stepId: string,
    dto: CheckIssueStepDto,
    user: JwtUser,
    ability: AppAbility,
  ) {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: { assignments: ownerInclude },
    });
    if (!ticket) throw new NotFoundException('Repair ticket not found');
    workAccess(ability, ticket);
    if (ticket.repairStatus !== RepairStatus.IN_PROGRESS) {
      throw new BadRequestException(
        'Steps can only be ticked while the ticket is In progress.',
      );
    }
    const step = await this.prisma.repairIssueStep.findFirst({
      where: { id: stepId, repairIssue: { id: issueId, repairTicketId: id } },
    });
    if (!step) throw new NotFoundException('Step not found on this ticket');

    const updated = await this.prisma.repairIssueStep.update({
      where: { id: stepId },
      data: dto.checked
        ? { checkedAt: new Date(), checkedByEmail: user.email }
        : { checkedAt: null, checkedByEmail: null },
    });
    return {
      id: updated.id,
      position: updated.position,
      text: updated.text,
      checkedAt: updated.checkedAt,
      checkedByEmail: updated.checkedByEmail,
    };
  }

  // ── Update costs (dedicated endpoint) ────────────────────────────────────

  // ticket.costs.edit is checked by the route's guard
  async updateCosts(
    id: string,
    dto: UpdateCostsDto,
    user: JwtUser,
    ability: AppAbility,
  ) {
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: { repairParts: true },
    });

    if (!ticket) throw new NotFoundException('Repair ticket not found');

    if (
      dto.lastUpdatedAt &&
      ticket.updatedAt.toISOString() !== dto.lastUpdatedAt
    ) {
      throw new ConflictException(
        'This ticket has been updated by another user. Please reload the page to see the latest changes.',
      );
    }

    // Cost encoding only available at FOR_VERIFICATION or once finished
    if (
      ticket.repairStatus !== RepairStatus.FOR_VERIFICATION &&
      !isFinished(ticket.repairStatus)
    ) {
      throw new BadRequestException(
        'Cost encoding is only available once the ticket reaches "For Verification" status.',
      );
    }

    if (isFinished(ticket.repairStatus) && !ticket.isUnlocked) {
      throw new BadRequestException(
        'This ticket is locked. You must unlock the ticket first to edit costs.',
      );
    }

    let partsCost: number;
    const laborCost = dto.laborCost ?? Number(ticket.laborCost ?? 0);

    if (!dto.isLumpSum && (!dto.parts || dto.parts.length === 0)) {
      throw new BadRequestException(
        'At least one part is required in itemized mode',
      );
    }

    let partsData: {
      repairTicketId: string;
      description: string;
      unitCost: number;
      quantity: number;
      subtotal: number;
    }[] = [];

    if (dto.isLumpSum) {
      partsCost = dto.partsCost ?? Number(ticket.partsCost ?? 0);
    } else {
      partsData = dto.parts!.map((p) => ({
        repairTicketId: id,
        description: p.description,
        unitCost: p.unitCost,
        quantity: p.quantity,
        subtotal: p.unitCost * p.quantity,
      }));
      partsCost = partsData.reduce((sum, p) => sum + Number(p.subtotal), 0);
    }

    const totalCost = partsCost + laborCost;
    // One COST_UPDATE row for the whole save, with every field that changed (spec 0010, AC-6)
    const event = costEvent(
      {
        partsCost: ticket.partsCost != null ? Number(ticket.partsCost) : null,
        laborCost: ticket.laborCost != null ? Number(ticket.laborCost) : null,
        totalCost: ticket.totalCost != null ? Number(ticket.totalCost) : null,
        isLumpSum: ticket.isLumpSum,
      },
      { partsCost, laborCost, totalCost, isLumpSum: dto.isLumpSum },
    );
    const audited = event.changes.length > 0;
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Clear existing itemized parts
      await tx.repairPart.deleteMany({ where: { repairTicketId: id } });

      // Re-create parts if itemized
      if (!dto.isLumpSum && partsData.length > 0) {
        await tx.repairPart.createMany({ data: partsData });
      }

      await tx.repairTicket.update({
        where: { id },
        data: {
          isLumpSum: dto.isLumpSum,
          partsCost,
          laborCost,
          totalCost,
          isUnlocked: false,
          // A save that changes no amount writes no audit row, so it is not activity (AC-10)
          ...(audited && { lastActivityAt: now }),
        },
      });

      if (audited) {
        await tx.auditLog.create({
          data: { repairTicketId: id, ...auditData(user, event, now) },
        });
      }
    });

    const updated = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: ticketInclude,
    });

    this.logger.log(
      `Costs updated on ticket ${ticket.repairNumber} by ${user.email}`,
    );
    return this.present(updated!, ability);
  }

  // ── List available (unoccupied) in-house mechanics ────────────────────────

  async listAvailableMechanics() {
    // Active mechanics not assigned to any open ticket
    return this.prisma.mechanic.findMany({
      where: {
        isActive: true,
        assignments: {
          none: { repairTicket: { repairStatus: { in: OPEN_STATUSES } } },
        },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  // ── Unlock terminal ticket ────────────────────────────────────────────────

  // ticket.unlock is checked by the route's guard
  async unlockTicket(
    id: string,
    dto: UnlockTicketDto,
    user: JwtUser,
    ability: AppAbility,
  ) {
    const ticket = await this.prisma.repairTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('Repair ticket not found');

    if (!isFinished(ticket.repairStatus)) {
      throw new BadRequestException(
        'Only Closed or Cancelled tickets can be unlocked',
      );
    }

    if (ticket.isUnlocked) {
      throw new BadRequestException('This ticket is already unlocked');
    }

    const now = new Date();
    const [updated] = await this.prisma.$transaction([
      this.prisma.repairTicket.update({
        where: { id },
        data: {
          isUnlocked: true,
          unlockReason: dto.unlockReason.trim(),
          lastActivityAt: now,
        },
        include: ticketInclude,
      }),
      this.prisma.auditLog.create({
        data: {
          repairTicketId: id,
          ...auditData(user, unlockEvent(dto.unlockReason), now),
        },
      }),
    ]);

    this.logger.log(
      `Ticket ${ticket.repairNumber} unlocked by ${user.email}: ${dto.unlockReason}`,
    );
    return this.present(updated, ability);
  }

  // ── Audit timeline (keyset paged, newest first) ──────────────────────────

  async findAuditEvents(
    query: AuditEventsQueryDto,
  ): Promise<{ data: AuditEvent[]; nextCursor: string | null }> {
    const limit = query.limit ?? AUDIT_PAGE_SIZE;
    const { from, to } = parseRange(query.from, query.to);
    const repairNumber = query.repairNumber?.trim();

    const filters: Prisma.AuditLogWhereInput[] = [];
    if (query.type) filters.push({ action: query.type });
    // The Person filter carries a welinc-auth user id (spec 0009, AC-10)
    if (query.actorId) filters.push({ actorUserId: query.actorId });
    if (from || to)
      filters.push({
        createdAt: { ...(from && { gte: from }), ...(to && { lt: to }) },
      });
    if (repairNumber && repairNumber.length >= 2) {
      filters.push({
        repairTicket: {
          repairNumber: { contains: repairNumber, mode: 'insensitive' },
        },
      });
    }
    if (query.ticketId) filters.push({ repairTicketId: query.ticketId });
    if (query.cursor) filters.push(olderThan(decodeCursor(query.cursor)));

    // One extra row tells us whether anything older remains
    const rows = await this.prisma.auditLog.findMany({
      where: { AND: filters },
      select: {
        id: true,
        action: true,
        actorUserId: true,
        actorName: true,
        actorEmail: true,
        actorRole: true,
        changes: true,
        note: true,
        createdAt: true,
        repairTicket: { select: { id: true, repairNumber: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = rows.slice(0, limit);

    return {
      data: page.map(toAuditEvent),
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  /**
   * One entry per person who wrote an audit row, with the name and email of their newest row
   * (spec 0009, AC-10). Rows with no user id (system events) are left out.
   */
  async findAuditActors() {
    const rows = await this.prisma.$queryRaw<
      { userId: string; actorName: string | null; email: string | null }[]
    >`
      SELECT DISTINCT ON (actor_user_id)
        actor_user_id AS "userId", actor_name AS "actorName", actor_email AS email
      FROM audit_logs
      WHERE actor_user_id IS NOT NULL
      ORDER BY actor_user_id, created_at DESC, id DESC
    `;
    return rows
      .map((r) => ({
        id: r.userId,
        name: r.actorName ?? r.email ?? '',
        email: r.email,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** formatTicket plus each linked entry's typical hours, for one ticket (spec 0007, AC-27). */
  private async present(ticket: TicketRow, ability: AppAbility) {
    const issues = ticket.issues;
    const entryIds = [
      ...new Set(
        issues.flatMap((i) => (i.knowledgeEntryId ? [i.knowledgeEntryId] : [])),
      ),
    ];
    const stats = await loadStats(this.prisma, entryIds);
    const hours = new Map(
      entryIds.map((id) => [id, stats.get(id)?.typicalHours ?? null]),
    );
    return this.formatTicket(ticket, ability, hours);
  }

  private formatTicket(
    ticket: TicketRow,
    ability: AppAbility,
    typicalHours: Map<string, number | null> = new Map(),
  ) {
    const costs = visibleCostFields(ability);
    // != null so a stored 0 is sent as 0 (recorded); a field the caller may not read is null (AC-11)
    const cost = (field: CostField) => {
      const value = ticket[field];
      return costs.has(field) && value != null ? Number(value) : null;
    };
    const target = subject('RepairTicket', ticket);
    const base = {
      id: ticket.id,
      repairNumber: ticket.repairNumber,
      status: ticket.repairStatus,
      vehiclePlate: ticket.vehicle.plateNumber,
      vehicleModel: ticket.vehicle.model,
      driverName: ticket.driver.name,
      garageLocation: ticket.garage.name,
      odometerReading: ticket.odometer,
      priority: ticket.priority,
      dueAt: ticket.dueAt?.toISOString() ?? null,
      dueAtSource: ticket.dueAtSource,
      reportedByName: ticket.reportedByName,
      verifiedByName: ticket.verifiedByName,
      verifiedAt: ticket.verifiedAt?.toISOString() ?? null,
      issueDescription:
        ticket.issues && ticket.issues.length > 0
          ? ticket.issues.map((i) => i.description).join(', ')
          : '',
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      lastActivityAt: ticket.lastActivityAt.toISOString(),
      closedAt: ticket.closedAt?.toISOString() ?? null,
      cancellationReason: ticket.cancellationReason,
      remarks: ticket.remarks,
      issues: ticket.issues.map((i) => formatIssue(i, typicalHours)),
      // Built from TicketAssignment, so callers see the same list as before (AC-5)
      mechanics: ticket.assignments.map((a) => ({
        id: a.mechanic.id,
        name: a.mechanic.name,
      })),
      partsCost: cost('partsCost'),
      laborCost: cost('laborCost'),
      totalCost: cost('totalCost'),
      // What the caller may do on this ticket, so the web app never guesses (spec 0011, AC-12a)
      can: {
        work: ability.can('work', target),
        administer: ability.can('administer', target),
        editCosts: ability.can('editCosts', target),
        unlock: ability.can('unlock', target),
      },
    };

    // The rest of the cost record follows the same key, as before the matrix (AC-14).
    // A ticket's history is read from GET /vrms/repairs/audit-logs?ticketId=
    if (costs.has('totalCost')) {
      return {
        ...base,
        isLumpSum: ticket.isLumpSum,
        isUnlocked: ticket.isUnlocked,
        unlockReason: ticket.unlockReason,
        driverIsVerified: ticket.driver.isVerified,
        repairParts: ticket.repairParts.map((p) => ({
          id: p.id,
          description: p.description,
          unitCost: Number(p.unitCost),
          quantity: p.quantity,
          subtotal: Number(p.subtotal),
        })),
      };
    }

    return base;
  }
}
