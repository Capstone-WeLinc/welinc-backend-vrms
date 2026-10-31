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
import {
  KnowledgeEntryStatus,
  Prisma,
  RepairStatus,
  type RepairTicket,
  VehicleStatus,
} from '@prisma/client';
import { applyStatusMove } from './apply-status-move';
import {
  findMove,
  invalidMoveMessage,
  statusMovesFrom,
  type TicketMove,
} from './ticket-transitions';
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
  toAuditEvent,
  unlockEvent,
  whoName,
} from './audit-events';
import {
  FINISHED_STATUSES,
  isFinished,
  OPEN_STATUSES,
} from './ticket-statuses';
import { readableTickets } from './ticket-access';
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
import { ModuleDisabledException } from '../../settings/module-disabled';
import { SettingsService } from '../../settings/settings.service';
import { EmbeddingService } from '../ai/embedding.service';
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

type CostField = (typeof COST_FIELDS)[number];

/** The cost fields the caller may read; without ticket.costs.view, none (spec 0011, AC-11). */
function visibleCostFields(ability: AppAbility): ReadonlySet<CostField> {
  const permitted = permittedFieldsOf(ability, 'read', 'RepairTicket', {
    fieldsFrom: (rule) => rule.fields ?? [...COST_FIELDS],
  });
  return new Set(COST_FIELDS.filter((field) => permitted.includes(field)));
}

/**
 * Whether the caller may change this ticket's steps and known fixes (spec 0011, AC-12):
 * ticket.administer on any ticket, ticket.work on their own. Anyone else gets a 403. Status
 * moves check their own right per move (spec 0014, AC-6).
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

/** A ticket loaded with its assignments' welinc-auth ids, as both load shapes carry them. */
type MoveSubject = RepairTicket & {
  assignments: { mechanic: { authUserId: string | null } }[];
};

/** Whether the caller holds a status move's right on this ticket (spec 0014, AC-6). */
function mayMake(
  move: TicketMove,
  ability: AppAbility,
  ticket: MoveSubject,
): boolean {
  const target = subject('RepairTicket', ticket);
  switch (move.right) {
    case 'work':
      return ability.can('work', target) || ability.can('administer', target);
    case 'administer':
      return ability.can('administer', target);
    case 'verify':
      // ticket.verify on a ticket the caller may read and is not assigned to (the ability's
      // cannot rule); ticket.administer alone no longer closes
      return ability.can('verify', target) && ability.can('read', target);
    default:
      return false;
  }
}

/** The status endpoint moves this caller may make on this ticket right now (AC-13). */
function movesFor(ticket: MoveSubject, ability: AppAbility): TicketMove[] {
  return statusMovesFrom(ticket.repairStatus).filter((m) =>
    mayMake(m, ability, ticket),
  );
}

/** The 400 for a move outside the table or owned by a later feature (AC-3). */
function invalidTransition(
  ticket: MoveSubject,
  to: RepairStatus,
  ability: AppAbility,
) {
  const from = ticket.repairStatus;
  const message =
    from === to && isFinished(from)
      ? 'Closed and Cancelled tickets are locked. An Admin must unlock this ticket first.'
      : invalidMoveMessage(from, to);
  return new BadRequestException({
    statusCode: 400,
    code: 'INVALID_TRANSITION',
    message,
    allowed: movesFor(ticket, ability).map((m) => m.to),
  });
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
      mechanic: {
        select: { id: true, name: true, authUserId: true, isActive: true },
      },
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly embeddings: EmbeddingService,
  ) {}

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
    // Never awaited: embedding must not fail or slow the save (spec 0013, AC-14)
    void this.embeddings.embedIssuesInBackground(
      ticket.issues.map((i) => i.id),
    );
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
      include: { assignments: ownerInclude, issues: true },
    });

    // AC-3a: the first failing check answers, in this order
    if (!ticket) throw new NotFoundException('Repair ticket not found');

    if (ticket.updatedAt.toISOString() !== dto.lastUpdatedAt) {
      throw new ConflictException(STALE_TICKET);
    }

    const from = ticket.repairStatus;
    // AC-4: an unlocked finished ticket saved with its own status keeps today's save
    if (from === dto.status && isFinished(from) && ticket.isUnlocked) {
      return this.saveUnlocked(ticket, dto, ability);
    }

    const move = findMove(from, dto.status);
    if (!move || move.trigger !== 'status') {
      throw invalidTransition(ticket, dto.status, ability);
    }

    if (!mayMake(move, ability, ticket)) {
      const selfVerify =
        move.right === 'verify' &&
        ability.can('ticket.verify', 'Permission') &&
        ticket.assignments.some((a) => a.mechanic.authUserId === user.sub);
      throw new ForbiddenException(
        selfVerify
          ? "Someone else must verify work on a ticket you're assigned to."
          : "You can't make this move on this ticket.",
      );
    }

    // The values the move needs, last (AC-3a)
    const remarks = dto.remarks?.trim() || null;
    const reason = dto.cancellationReason?.trim() || null;
    if (
      move.needs?.includes('remarks') &&
      (!remarks || remarks.length < 5 || remarks.length > 500)
    ) {
      throw new BadRequestException('Say what needs fixing.');
    }
    if (move.needs?.includes('cancellationReason') && !reason) {
      throw new BadRequestException('A cancellation reason is required');
    }
    // Spec 0007, AC-31 kept exactly (AC-11): "What fixed it" for every issue, while the
    // knowledge base is on (spec 0012, AC-15)
    const resolutions =
      move.needs?.includes('resolutions') &&
      this.settings.isModuleOn('knowledge')
        ? checkResolutions(ticket.issues, dto.resolutions)
        : null;

    // One clock reading for the audit row, lastActivityAt and the close fields
    const now = new Date();
    const data: Prisma.RepairTicketUpdateManyMutationInput = {
      ...this.costData(ticket, dto, ability),
      ...(move.to === RepairStatus.CANCELLED && { cancellationReason: reason }),
      // Send back's comment lives only in its audit row (AC-8); other moves keep the latest remark
      ...(remarks && !move.needs?.includes('remarks') && { remarks }),
    };
    const issues = resolutions
      ? ticket.issues.map((issue) => ({
          id: issue.id,
          data: resolutionData(
            resolutions.get(issue.id)!,
            !!issue.knowledgeEntryId,
            now,
          ),
        }))
      : [];

    const updated = await this.prisma.$transaction(async (tx) => {
      await applyStatusMove(
        tx,
        ticket,
        move,
        user,
        move.to === RepairStatus.CANCELLED ? reason : remarks,
        now,
        { data, issues },
      );
      return tx.repairTicket.findUniqueOrThrow({
        where: { id },
        include: ticketInclude,
      });
    });

    this.logger.log(
      `Repair ticket ${ticket.repairNumber} status updated to ${move.to} by ${user.email} (${move.id})`,
    );

    return this.present(updated, ability);
  }

  /** Cost fields sent with a status body; ignored without ticket.costs.edit (spec 0011, AC-11). */
  private costData(
    ticket: RepairTicket,
    dto: UpdateRepairStatusDto,
    ability: AppAbility,
  ): Prisma.RepairTicketUpdateManyMutationInput {
    if (!ability.can('editCosts', subject('RepairTicket', ticket))) return {};
    if (dto.partsCost === undefined && dto.laborCost === undefined) return {};
    const parts = dto.partsCost ?? Number(ticket.partsCost ?? 0);
    const labor = dto.laborCost ?? Number(ticket.laborCost ?? 0);
    return {
      ...(dto.partsCost !== undefined && { partsCost: dto.partsCost }),
      ...(dto.laborCost !== undefined && { laborCost: dto.laborCost }),
      totalCost: parts + labor,
    };
  }

  /**
   * AC-4: an unlocked finished ticket saved with its own status. No move and no audit row:
   * the fields are saved and the ticket locks again, through the same stale check.
   */
  private async saveUnlocked(
    ticket: RepairTicket,
    dto: UpdateRepairStatusDto,
    ability: AppAbility,
  ) {
    const remarks = dto.remarks?.trim();
    const reason = dto.cancellationReason?.trim();
    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.repairTicket.updateMany({
        where: { id: ticket.id, updatedAt: ticket.updatedAt },
        data: {
          ...this.costData(ticket, dto, ability),
          ...(remarks && { remarks }),
          ...(reason && { cancellationReason: reason }),
          isUnlocked: false,
          updatedAt: new Date(),
        },
      });
      if (count === 0) throw new ConflictException(STALE_TICKET);
      return tx.repairTicket.findUniqueOrThrow({
        where: { id: ticket.id },
        include: ticketInclude,
      });
    });
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
    // The route's keys belong to no module, so the knowledge switch is checked here (AC-11)
    if (!this.settings.isModuleOn('knowledge')) {
      throw new ModuleDisabledException('knowledge');
    }
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

    if (ticket.updatedAt.toISOString() !== dto.lastUpdatedAt) {
      throw new ConflictException(STALE_TICKET);
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

    const updated = await this.prisma.$transaction(async (tx) => {
      // The stale check again, first: only the loaded updatedAt may move on (spec 0014, AC-12)
      const { count } = await tx.repairTicket.updateMany({
        where: { id, updatedAt: ticket.updatedAt },
        data: {
          isLumpSum: dto.isLumpSum,
          partsCost,
          laborCost,
          totalCost,
          isUnlocked: false,
          updatedAt: now,
          // A save that changes no amount writes no audit row, so it is not activity (AC-10)
          ...(audited && { lastActivityAt: now }),
        },
      });
      if (count === 0) throw new ConflictException(STALE_TICKET);

      // Clear existing itemized parts, then re-create them if itemized
      await tx.repairPart.deleteMany({ where: { repairTicketId: id } });
      if (!dto.isLumpSum && partsData.length > 0) {
        await tx.repairPart.createMany({ data: partsData });
      }

      if (audited) {
        await tx.auditLog.create({
          data: { repairTicketId: id, ...auditData(user, event, now) },
        });
      }
      return tx.repairTicket.findUniqueOrThrow({
        where: { id },
        include: ticketInclude,
      });
    });

    this.logger.log(
      `Costs updated on ticket ${ticket.repairNumber} by ${user.email}`,
    );
    return this.present(updated, ability);
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

    if (ticket.updatedAt.toISOString() !== dto.lastUpdatedAt) {
      throw new ConflictException(STALE_TICKET);
    }

    if (!isFinished(ticket.repairStatus)) {
      throw new BadRequestException(
        'Only Closed or Cancelled tickets can be unlocked',
      );
    }

    if (ticket.isUnlocked) {
      throw new BadRequestException('This ticket is already unlocked');
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // The stale check again inside the transaction (spec 0014, AC-12)
      const { count } = await tx.repairTicket.updateMany({
        where: { id, updatedAt: ticket.updatedAt },
        data: {
          isUnlocked: true,
          unlockReason: dto.unlockReason.trim(),
          lastActivityAt: now,
          updatedAt: now,
        },
      });
      if (count === 0) throw new ConflictException(STALE_TICKET);
      await tx.auditLog.create({
        data: {
          repairTicketId: id,
          ...auditData(user, unlockEvent(dto.unlockReason), now),
        },
      });
      return tx.repairTicket.findUniqueOrThrow({
        where: { id },
        include: ticketInclude,
      });
    });

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
    const stats = await loadStats(
      this.prisma,
      entryIds,
      this.settings.get('knowledge.min_samples'),
    );
    const hours = new Map(
      entryIds.map((id) => [id, stats.get(id)?.typicalHours ?? null]),
    );
    return {
      ...this.formatTicket(ticket, ability, hours),
      // Single ticket responses only; list rows carry neither (spec 0014, AC-13)
      moves: this.movesOut(ticket, ability),
    };
  }

  /** The moves the web app offers: the status endpoint moves this caller may make now (AC-13). */
  private movesOut(ticket: TicketRow, ability: AppAbility) {
    const knowledgeOn = this.settings.isModuleOn('knowledge');
    return movesFor(ticket, ability).map((m) => {
      const need = m.needs?.[0] ?? null;
      return {
        to: m.to,
        label: m.label!,
        kind: m.kind,
        needs: need === 'resolutions' && !knowledgeOn ? null : need,
      };
    });
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
    const open = OPEN_STATUSES.includes(ticket.repairStatus);
    const working =
      ticket.repairStatus === RepairStatus.IN_PROGRESS ||
      ticket.repairStatus === RepairStatus.ON_HOLD;
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
      // Spec 0011, AC-34: worked out from the loaded assignments, so a list costs no extra query
      hasInactiveMechanic:
        open && ticket.assignments.some((a) => !a.mechanic.isActive),
      needsMechanic:
        working && !ticket.assignments.some((a) => a.mechanic.isActive),
      // What the caller may do on this ticket, so the web app never guesses (spec 0011, AC-12a)
      can: {
        work: ability.can('work', target),
        administer: ability.can('administer', target),
        // Spec 0014, AC-13: false on a ticket the caller is assigned to
        verify: ability.can('verify', target),
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
