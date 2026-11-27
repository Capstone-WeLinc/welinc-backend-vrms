import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { subject } from '@casl/ability';
import { permittedFieldsOf } from '@casl/ability/extra';
import {
  KnowledgeEntryStatus,
  Prisma,
  RepairStatus,
  type RepairTicket,
} from '@prisma/client';
import { applyStatusMove } from './apply-status-move';
import { dueSoonAt, recomputeDueAt, type RecomputeOptions } from './due-dates';
import {
  livePhotoCounts,
  PhotoCounts,
  photoNeedUnmet,
  PhotoSwitches,
} from './photo-rules';
import {
  findMove,
  invalidMoveMessage,
  statusMovesFrom,
  type TicketMove,
} from './ticket-transitions';
import { RoleCode } from '../../auth/roles';
import {
  type AppAbility,
  canViewCosts,
  COST_FIELDS,
} from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import {
  AuditEvent,
  AuditEventData,
  auditCatalog,
  auditData,
  auditKindFilter,
  auditRoleFilter,
  closedTicketTextEvent,
  costEvent,
  createdEvent,
  decodeCursor,
  encodeCursor,
  hiddenAuditEvents,
  knowledgeLinkEvent,
  lastRejectionFrom,
  lockedEvent,
  mechanicsChangedEvent,
  olderThan,
  referralOpenedEvent,
  REJECTION_SCAN_ROWS,
  stampedAt,
  stepTickEvent,
  storedCosts,
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
import { odometerProblem, vehicleOdometerFloor } from './odometer';
import {
  activeDriver,
  corporationName,
  driverForLicense,
  issueDescription,
} from './ticket-inputs';
import { AuditEventsQueryDto } from './dto/audit-events-query.dto';
import { queueVmmsRepairEvent } from '../integrations/vmms-repair-events';
import { waitingExpedites } from './expedite-views';
import {
  CHANGE_REASON,
  queueBmsRepairUpdate,
} from '../integrations/bms/bms-repair-updates';
import { applyFleetVehicle } from '../integrations/fleet/fleet-apply';
import {
  FleetUnavailableError,
  VmmsFleetClient,
  type FleetVehicle,
} from '../integrations/fleet/vmms-fleet.client';
import { DENIED } from '../../auth/permissions/permissions.guard';
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
  roles: { role: RoleCode; system: string }[];
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

/**
 * One option per verifier, sorted by name. The name is a snapshot per ticket, so a
 * renamed user can appear under two names; the most recent verification's name wins.
 */
function verifierOptions(
  groups: {
    verifiedByUserId: string | null;
    verifiedByName: string | null;
    _max: { verifiedAt: Date | null };
  }[],
): { id: string; name: string }[] {
  const latest = new Map<string, { name: string; at: number }>();
  for (const g of groups) {
    if (!g.verifiedByUserId || !g.verifiedByName) continue;
    const at = g._max.verifiedAt?.getTime() ?? 0;
    const seen = latest.get(g.verifiedByUserId);
    if (!seen || at > seen.at) {
      latest.set(g.verifiedByUserId, { name: g.verifiedByName, at });
    }
  }
  return [...latest]
    .map(([id, { name }]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

/**
 * Spec 0015, AC-5: a ticket has costs when any cost column is set or a part is listed. Reads the
 * stored values, not what the caller may see.
 */
function hasCosts(
  ticket: Pick<RepairTicket, 'partsCost' | 'laborCost' | 'totalCost'> & {
    repairParts?: unknown[];
  },
): boolean {
  return (
    ticket.partsCost != null ||
    ticket.laborCost != null ||
    ticket.totalCost != null ||
    (ticket.repairParts?.length ?? 0) > 0
  );
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

/** A unique violation on the repair number column (Prisma P2002), however the driver words it. */
function isRepairNumberCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return (
    error.code === 'P2002' &&
    /repair_?number/i.test(JSON.stringify(error.meta ?? {}))
  );
}

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
export const ticketInclude = {
  // isActive: spec 0029, AC-35's "Truck removed in VMMS"
  vehicle: {
    select: { plateNumber: true, model: true, status: true, isActive: true },
  },
  driver: { select: { name: true, licenseNumber: true, isVerified: true } },
  garage: { select: { name: true } },
  // Spec 0029, AC-12: the referral a ticket was opened from, for the "From VMMS WO-…" chip
  referrals: {
    where: { status: 'OPENED_TICKET' },
    select: { workOrderNumber: true },
    take: 1,
  },
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

export type TicketRow = Prisma.RepairTicketGetPayload<{
  include: typeof ticketInclude;
}>;

@Injectable()
export class RepairsService {
  private readonly logger = new Logger(RepairsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly embeddings: EmbeddingService,
    private readonly fleet: VmmsFleetClient,
  ) {}

  /**
   * Spec 0030, AC-5: the other services' way into the due date recompute, with this service's
   * settings. Runs inside their transaction, after their own writes.
   */
  recomputeDueAt(
    tx: Prisma.TransactionClient,
    ticketId: string,
    options: RecomputeOptions,
  ) {
    return recomputeDueAt(tx, ticketId, this.settings, options);
  }

  private async dueFields(tx: Prisma.TransactionClient, ticketId: string) {
    return tx.repairTicket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { dueAt: true, dueAtSource: true, lastActivityAt: true },
    });
  }

  // ── Create repair ticket ─────────────────────────────────────────────────

  async create(dto: CreateRepairDto, user: JwtUser, ability: AppAbility) {
    // Checks that need no lock run first, outside the transaction (spec 0016, AC-2). Only trucks
    // linked to VMMS can be picked (spec 0029, AC-5)
    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        plateNumber: dto.vehiclePlate,
        isActive: true,
        deletedAt: null,
        vmmsVehicleId: { not: null },
      },
    });
    if (!vehicle?.vmmsVehicleId) {
      throw new BadRequestException(
        `Vehicle with plate number "${dto.vehiclePlate}" not found`,
      );
    }
    const { fresh, fleetStale } = await this.freshTruck(vehicle.vmmsVehicleId);

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

    // Spec 0007, AC-26: each issue's category must be active, and a picked entry Active
    const { categories, entries } = await this.issueSources(dto);

    // Spec 0016, AC-4: the account and the corporation snapshot
    const corporation = await this.corporationFor(dto);

    // Spec 0029, AC-8 and AC-11: a ticket from a VMMS referral, for its truck only
    const referral = dto.referralId
      ? await this.referralFor(dto.referralId, vehicle.id, ability)
      : null;

    // Spec 0016, AC-6: exactly one of an existing driver or a new one; spec 0029, AC-8: a
    // referral ticket may have none
    if (dto.driverId && dto.newDriver) {
      throw new BadRequestException('Choose or add a driver.');
    }
    if (!referral && !dto.driverId && !dto.newDriver) {
      throw new BadRequestException('Choose or add a driver.');
    }
    if (dto.driverId) await activeDriver(this.prisma, dto.driverId);

    // Mechanics are optional now (spec 0016, AC-1); any given must be active (spec 0010, AC-12)
    const mechanicIds = [...new Set((dto.mechanics ?? []).map((m) => m.id))];
    // Names for the MECHANIC_ASSIGNED row, in the order they were picked (spec 0021, AC-5b)
    let mechanicNames: string[] = [];
    if (mechanicIds.length > 0) {
      const active = await this.prisma.mechanic.findMany({
        // Suite spec 0018 child 0002, AC-33: only people who hold ticket.assignable
        where: { id: { in: mechanicIds }, isActive: true, assignable: true },
        select: { id: true, name: true },
      });
      if (active.length !== mechanicIds.length) {
        throw new BadRequestException('In house mechanic not found');
      }
      const nameOf = new Map(active.map((m) => [m.id, m.name]));
      mechanicNames = mechanicIds.map((mid) => nameOf.get(mid)!);
    }

    // A repairNumber collision regenerates the number and retries once, then answers 500
    let ticket: TicketRow | undefined;
    for (let attempt = 0; attempt < 2 && !ticket; attempt++) {
      const repairNumber = dto.repairNumber ?? generateRepairNumber();
      try {
        ticket = await this.prisma.$transaction((tx) =>
          this.createLocked(tx, {
            dto,
            user,
            repairNumber,
            vehicleId: vehicle.id,
            garageId: garage.id,
            mechanicIds,
            mechanicNames,
            corporation,
            categories,
            entries,
            referral,
            fresh,
          }),
        );
      } catch (error) {
        if (!isRepairNumberCollision(error)) throw error;
        if (attempt === 1 || dto.repairNumber) {
          this.logger.error(`Repair number collision on ${repairNumber}`);
          throw new InternalServerErrorException(
            'Could not create the repair ticket. Try again.',
          );
        }
      }
    }
    if (!ticket) throw new InternalServerErrorException();

    this.logger.log(
      `Repair ticket created — ${ticket.repairNumber} by ${user.email}`,
    );
    // Never awaited: embedding must not fail or slow the save (spec 0013, AC-14)
    void this.embeddings.embedIssuesInBackground(
      ticket.issues.map((i) => i.id),
    );
    // Spec 0029, AC-5: the form says "VMMS can't be reached, using the last copy"
    return { ...(await this.present(ticket, ability)), fleetStale };
  }

  /**
   * Spec 0029 (child 0001), AC-5: the truck read fresh from VMMS before the ticket is saved. A
   * truck VMMS doesn't have refuses the ticket; when VMMS can't be reached, create uses the copy.
   */
  private async freshTruck(
    vmmsVehicleId: string,
  ): Promise<{ fresh: FleetVehicle | null; fleetStale: boolean }> {
    let fresh: FleetVehicle | null;
    try {
      fresh = await this.fleet.vehicle(vmmsVehicleId);
    } catch (error) {
      if (!(error instanceof FleetUnavailableError)) throw error;
      this.logger.warn(
        `Ticket create uses the truck copy, VMMS unavailable: ${error.reason}`,
      );
      return { fresh: null, fleetStale: true };
    }
    if (!fresh) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'VEHICLE_NOT_IN_VMMS',
        message:
          'VMMS no longer has this truck. Ask VMMS Operations to add it.',
      });
    }
    return { fresh, fleetStale: false };
  }

  /**
   * The locked part of create (spec 0016, AC-2): lock the truck's row, refuse a second open
   * ticket, then write everything or nothing.
   */
  private async createLocked(
    tx: Prisma.TransactionClient,
    input: {
      dto: CreateRepairDto;
      user: JwtUser;
      repairNumber: string;
      vehicleId: string;
      garageId: string;
      mechanicIds: string[];
      mechanicNames: string[];
      corporation: string | null;
      categories: Map<string, { id: string; name: string }>;
      entries: Map<
        string,
        {
          id: string;
          name: string;
          steps: { position: number; text: string }[];
        }
      >;
      referral: { id: string; workOrderNumber: string } | null;
      /** The truck as VMMS has it now; null when VMMS can't be reached (AC-5). */
      fresh: FleetVehicle | null;
    },
  ) {
    const {
      dto,
      user,
      repairNumber,
      mechanicIds,
      corporation,
      categories,
      entries,
    } = input;

    const locked = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM vehicles
        WHERE id = ${input.vehicleId}::uuid AND is_active AND deleted_at IS NULL
        FOR UPDATE`,
    );
    if (locked.length === 0) {
      throw new BadRequestException(
        `Vehicle with plate number "${dto.vehiclePlate}" not found`,
      );
    }
    const open = await tx.repairTicket.findFirst({
      where: {
        vehicleId: input.vehicleId,
        repairStatus: { in: OPEN_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, repairNumber: true },
    });
    if (open) {
      throw new ConflictException({
        statusCode: 409,
        code: 'OPEN_TICKET_EXISTS',
        message: `This truck already has an open repair, ${open.repairNumber}. Add the new issues there.`,
        ticket: open,
      });
    }

    // Spec 0029, AC-5: the fresh VMMS read is applied under the truck's lock, before the
    // odometer floor reads it. A truck under maintenance no longer blocks a ticket
    if (input.fresh) await applyFleetVehicle(tx, input.fresh, new Date());

    // Spec 0016, AC-7: the reading may not drop below the truck's last one, and a big jump
    // must be confirmed
    const floor = await vehicleOdometerFloor(tx, input.vehicleId);
    const problem = odometerProblem(
      dto.odometerReading,
      floor,
      this.settings.get('tickets.odometer_jump_warn_km'),
      dto.confirmOdometerJump === true,
    );
    if (problem) throw problem;

    // Spec 0029, AC-8: decided under its lock, so two Admins can't both open a ticket from it
    if (input.referral) await this.lockWaitingReferral(tx, input.referral.id);

    const driverId =
      dto.driverId ??
      (dto.newDriver
        ? (await driverForLicense(tx, this.prisma, dto.newDriver)).id
        : null);

    // No mechanic: Open. One or more: Assigned (spec 0016, AC-1)
    const now = new Date();
    const reporter = { userId: user.sub, name: whoName(user) };
    // Spec 0021, AC-5b and AC-3b: CREATED, then MECHANIC_ASSIGNED when it starts Assigned
    const events = [
      createdEvent(),
      ...(input.referral
        ? [referralOpenedEvent(input.referral.workOrderNumber)]
        : []),
      ...(input.mechanicNames.length > 0
        ? [mechanicsChangedEvent('added', input.mechanicNames)]
        : []),
    ];
    const auditRows = events.map((event, i) =>
      auditData(user, event, stampedAt(now, i)),
    );
    // Spec 0030, AC-1: the due date's own audit row sorts 1 ms after the create rows
    const dueRowAt = stampedAt(now, events.length);
    const ticket = await tx.repairTicket.create({
      data: {
        repairNumber,
        vehicleId: input.vehicleId,
        driverId,
        garageId: input.garageId,
        odometer: dto.odometerReading,
        repairStatus:
          mechanicIds.length > 0 ? RepairStatus.ASSIGNED : RepairStatus.OPEN,
        priority: dto.priority,
        accountType: dto.accountType,
        corporation,
        reportedByUserId: reporter.userId,
        reportedByName: reporter.name,
        // The newest row's time (AC-3b): the due date row written right after (spec 0030)
        lastActivityAt: dueRowAt,
        statusChangedAt: now,
        // Linked issues get a copy of the entry's steps (the CREATED row covers the link, no KNOWLEDGE_LINK)
        issues: {
          create: dto.issues.map((issue) => {
            const entry = issue.knowledgeEntryId
              ? entries.get(issue.knowledgeEntryId)
              : undefined;
            return {
              // A blank description with a linked entry takes the entry's name (spec 0016, AC-5)
              description: issueDescription(
                categories.get(issue.categoryId)!.name,
                issue.rootCause,
                issue.description,
                entry?.name,
              ),
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
        // Nested so the ticket and its rows are saved together or not at all
        auditLogs: { create: auditRows },
      },
      include: ticketInclude,
    });

    if (input.referral) {
      await tx.referral.update({
        where: { id: input.referral.id },
        data: {
          status: 'OPENED_TICKET',
          repairTicketId: ticket.id,
          decidedByUserId: reporter.userId,
          decidedByName: reporter.name,
          decidedAt: now,
        },
      });
    }
    // Spec 0029, AC-13: VMMS hears of every ticket; one created Assigned sends OPENED with
    // OPEN, then STATUS_UPDATED with ASSIGNED
    await queueVmmsRepairEvent(tx, ticket.id, 'OPENED');
    if (ticket.repairStatus !== RepairStatus.OPEN) {
      await queueVmmsRepairEvent(tx, ticket.id, 'STATUS_UPDATED');
    }
    // Spec 0030, AC-1: every new ticket gets its due date, anchored on the stored createdAt.
    // Before create's own BMS update, which reads dueAt when it is queued, so BMS hears once.
    await recomputeDueAt(tx, ticket.id, this.settings, {
      trigger: 'CREATE',
      actor: user,
      now,
      at: dueRowAt,
      skipBmsUpdate: true,
    });
    // Child 0003, AC-17: BMS gets one update with the ticket as created, Assigned or not
    await queueBmsRepairUpdate(tx, ticket.id, CHANGE_REASON.opened);

    return { ...ticket, ...(await this.dueFields(tx, ticket.id)) };
  }

  /**
   * Spec 0029, AC-8 and AC-11: the referral a ticket is opened from. Needs `integration.respond`
   * on top of `ticket.create`, must be for the chosen truck, and must still be waiting (checked
   * again under its lock).
   */
  private async referralFor(
    referralId: string,
    vehicleId: string,
    ability: AppAbility,
  ) {
    if (!ability.can('integration.respond', 'Permission')) {
      throw new ForbiddenException(DENIED);
    }
    const referral = await this.prisma.referral.findUnique({
      where: { id: referralId },
      select: {
        id: true,
        vehicleId: true,
        status: true,
        workOrderNumber: true,
      },
    });
    if (!referral) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'REFERRAL_NOT_FOUND',
        message: 'This referral was not found.',
      });
    }
    if (referral.vehicleId !== vehicleId) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'REFERRAL_VEHICLE_MISMATCH',
        message: 'This referral is for another truck.',
      });
    }
    if (referral.status !== 'WAITING') throw referralAlreadyDecided();
    return { id: referral.id, workOrderNumber: referral.workOrderNumber };
  }

  private async lockWaitingReferral(
    tx: Prisma.TransactionClient,
    referralId: string,
  ) {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM referrals WHERE id = ${referralId}::uuid FOR UPDATE
    `;
    if (rows[0]?.status !== 'WAITING') throw referralAlreadyDecided();
  }

  /**
   * The corporation name to store: the active lookup value for CORPORATE, null for ONLINE, which
   * ignores any corporationId (spec 0016, AC-4).
   */
  private async corporationFor(dto: CreateRepairDto): Promise<string | null> {
    if (dto.accountType !== 'CORPORATE') return null;
    return corporationName(this.prisma, dto.corporationId);
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
    const { search, status, garageId, overdue, truckRemoved, mechanicId } =
      query;
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
      // Spec 0029, AC-35: like overdue, only ever open tickets
      ...(truckRemoved
        ? [
            { repairStatus: { in: OPEN_STATUSES } },
            { vehicle: { isActive: false } },
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
        orderBy:
          status === RepairStatus.FOR_VERIFICATION
            ? // Spec 0015, AC-9: oldest waiting first
              [{ statusChangedAt: 'asc' }, { id: 'asc' }]
            : [
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
    const { search, status, garageId, verifiedBy, page, limit } = query;
    const { from, to } = parseRange(query.from, query.to);
    const hideCosts = !visibleCostFields(ability).has('totalCost');
    const scope = readableTickets(ability);
    if (!scope) {
      return {
        data: [],
        total: 0,
        summary: { finished: 0, closed: 0, cancelled: 0, spend: null },
        verifiers: [],
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
    if (verifiedBy) where.verifiedByUserId = verifiedBy;
    if (from || to)
      where.closedAt = { ...(from && { gte: from }), ...(to && { lt: to }) };

    const [tickets, groups, verifierGroups] = await Promise.all([
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
          verifiedByName: true,
          verifiedAt: true,
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
      // Feature 23: the "Verified by" filter options. Scope only, never the other
      // filters, so the list stays put while someone narrows the table.
      this.prisma.repairTicket.groupBy({
        by: ['verifiedByUserId', 'verifiedByName'],
        where: {
          AND: [scope],
          repairStatus: RepairStatus.CLOSED,
          verifiedByUserId: { not: null },
        },
        _max: { verifiedAt: true },
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
        // Spec 0029, AC-12: null on a ticket opened from a VMMS referral
        driverName: t.driver?.name ?? null,
        garageLocation: t.garage.name,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        closedAt: t.closedAt?.toISOString() ?? null,
        cancellationReason: t.cancellationReason,
        isUnlocked: t.isUnlocked,
        verifiedByName: t.verifiedByName,
        verifiedAt: t.verifiedAt?.toISOString() ?? null,
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
      verifiers: verifierOptions(verifierGroups),
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
      include: {
        assignments: ownerInclude,
        issues: true,
        repairParts: { select: { id: true }, take: 1 },
      },
    });

    // AC-3a: the first failing check answers, in this order
    if (!ticket) throw new NotFoundException('Repair ticket not found');

    if (ticket.updatedAt.toISOString() !== dto.lastUpdatedAt) {
      throw new ConflictException(STALE_TICKET);
    }

    const from = ticket.repairStatus;
    // AC-4: an unlocked finished ticket saved with its own status keeps today's save
    if (from === dto.status && isFinished(from) && ticket.isUnlocked) {
      return this.saveUnlocked(ticket, dto, user, ability);
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
    // Spec 0015, AC-5: the close can require costs, counting any sent with this request
    if (
      move.to === RepairStatus.CLOSED &&
      this.settings.get('tickets.require_costs_to_close') &&
      !hasCosts(ticket) &&
      !(
        ability.can('editCosts', subject('RepairTicket', ticket)) &&
        (dto.partsCost != null || dto.laborCost != null)
      )
    ) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'COSTS_REQUIRED',
        message: 'Add the costs before closing this ticket.',
      });
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
        // Spec 0018, AC-7: the photo rules run last, under the row lock the move takes
        { data, issues, photoRules: this.photoSwitches() },
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
   * AC-4: an unlocked finished ticket saved with its own status. No move: the fields are saved
   * and the ticket locks again, through the same stale check. Spec 0021, AC-1 to AC-3b: it writes
   * COST_UPDATE, TICKET_EDITED and LOCKED rows, in that order, in the same transaction.
   */
  private async saveUnlocked(
    ticket: RepairTicket,
    dto: UpdateRepairStatusDto,
    user: JwtUser,
    ability: AppAbility,
  ) {
    const remarks = dto.remarks?.trim() || null;
    const reason = dto.cancellationReason?.trim() || null;
    const costs = this.costData(ticket, dto, ability);
    const note = ticket.isUnlocked ? ticket.unlockReason : null;

    const before = storedCosts(ticket);
    const events = [
      costEvent(
        before,
        {
          partsCost:
            costs.partsCost !== undefined
              ? Number(costs.partsCost)
              : before.partsCost,
          laborCost:
            costs.laborCost !== undefined
              ? Number(costs.laborCost)
              : before.laborCost,
          totalCost:
            costs.totalCost !== undefined
              ? Number(costs.totalCost)
              : before.totalCost,
          isLumpSum: before.isLumpSum,
        },
        note,
      ),
      closedTicketTextEvent(
        {
          remarks: ticket.remarks,
          cancellationReason: ticket.cancellationReason,
        },
        {
          remarks: remarks ?? ticket.remarks,
          cancellationReason: reason ?? ticket.cancellationReason,
        },
        note,
      ),
      ticket.isUnlocked ? lockedEvent() : null,
    ].filter((e): e is AuditEventData => !!e && e.changes.length > 0);

    const now = new Date();
    const rows = events.map((event, i) => ({
      repairTicketId: ticket.id,
      ...auditData(user, event, stampedAt(now, i)),
    }));

    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.repairTicket.updateMany({
        where: { id: ticket.id, updatedAt: ticket.updatedAt },
        data: {
          ...costs,
          ...(remarks && { remarks }),
          ...(reason && { cancellationReason: reason }),
          isUnlocked: false,
          updatedAt: now,
          // The newest row's time; unchanged when nothing is written (AC-3b)
          ...(rows.length > 0 && {
            lastActivityAt: rows[rows.length - 1].createdAt,
          }),
        },
      });
      if (count === 0) throw new ConflictException(STALE_TICKET);
      for (const data of rows) await tx.auditLog.create({ data });
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

      // Spec 0023, AC-14: the checklist lock moves before the steps are replaced, so an Edit
      // steps dialog opened before this relink gets 409, and a running save finishes first
      await tx.repairIssue.update({
        where: { id: issueId },
        data: { checklistVersion: { increment: 1 } },
      });
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
      // Spec 0030, AC-5: link, relink and unlink change the issue's hours
      await recomputeDueAt(tx, id, this.settings, {
        trigger: 'KNOWN_FIX',
        actor: user,
        now,
        at: stampedAt(now, 1),
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

  /**
   * Tick or untick one copied step while In progress. Never touches the ticket's updatedAt
   * (AC-28). Spec 0021, AC-4 and AC-5: the checks, a conditional update, the STEP_CHECKED or
   * STEP_UNCHECKED row and lastActivityAt run in one transaction; a tick that changes nothing
   * writes nothing, so two ticks at once leave exactly one row.
   */
  async checkStep(
    id: string,
    issueId: string,
    stepId: string,
    dto: CheckIssueStepDto,
    user: JwtUser,
    ability: AppAbility,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.repairTicket.findUnique({
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
      const step = await tx.repairIssueStep.findFirst({
        where: {
          id: stepId,
          repairIssue: { id: issueId, repairTicketId: id },
        },
      });
      if (!step) throw new NotFoundException('Step not found on this ticket');

      // Only a real change matches: a second tick waits on the row lock, then counts 0
      const now = new Date();
      const { count } = await tx.repairIssueStep.updateMany({
        where: {
          id: stepId,
          checkedAt: dto.checked ? null : { not: null },
        },
        data: dto.checked
          ? { checkedAt: now, checkedByEmail: user.email }
          : { checkedAt: null, checkedByEmail: null },
      });
      if (count > 0) {
        await tx.auditLog.create({
          data: {
            repairTicketId: id,
            ...auditData(user, stepTickEvent(dto.checked, step, issueId), now),
          },
        });
        // updatedAt passed as stored, so @updatedAt leaves it alone (spec 0014)
        await tx.repairTicket.update({
          where: { id },
          data: { lastActivityAt: now, updatedAt: ticket.updatedAt },
        });
      }
      return tx.repairIssueStep.findUniqueOrThrow({ where: { id: stepId } });
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
    // One COST_UPDATE row for the whole save, with every field that changed (spec 0010, AC-6),
    // then LOCKED when the save relocks an unlocked ticket (spec 0021, AC-1, AC-3, AC-3b)
    const note = ticket.isUnlocked ? ticket.unlockReason : null;
    const events = [
      costEvent(
        storedCosts(ticket),
        { partsCost, laborCost, totalCost, isLumpSum: dto.isLumpSum },
        note,
      ),
      ...(ticket.isUnlocked ? [lockedEvent()] : []),
    ].filter((e) => e.changes.length > 0);
    const now = new Date();
    const rows = events.map((event, i) => ({
      repairTicketId: id,
      ...auditData(user, event, stampedAt(now, i)),
    }));

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
          // A save that writes no audit row is not activity (spec 0010, AC-10); else the newest row's time
          ...(rows.length > 0 && {
            lastActivityAt: rows[rows.length - 1].createdAt,
          }),
        },
      });
      if (count === 0) throw new ConflictException(STALE_TICKET);

      // Clear existing itemized parts, then re-create them if itemized
      await tx.repairPart.deleteMany({ where: { repairTicketId: id } });
      if (!dto.isLumpSum && partsData.length > 0) {
        await tx.repairPart.createMany({ data: partsData });
      }

      for (const data of rows) await tx.auditLog.create({ data });
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
    ability: AppAbility,
  ): Promise<{ data: AuditEvent[]; nextCursor: string | null }> {
    const limit = query.limit ?? AUDIT_PAGE_SIZE;
    const { from, to } = parseRange(query.from, query.to);
    const repairNumber = query.repairNumber?.trim();

    const filters: Prisma.AuditLogWhereInput[] = [];
    // Spec 0021, AC-9 and AC-10: categories and types as a union, the old `type` merged in
    const types = [
      ...new Set([...(query.types ?? []), ...(query.type ? [query.type] : [])]),
    ];
    const kind = auditKindFilter(query.categories, types);
    if (kind) filters.push(kind);
    const role = auditRoleFilter(query.actorRole);
    if (role) filters.push(role);
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
    // Spec 0017, AC-16 and spec 0021, AC-12: document and cost events stay hidden without ticket.costs.view
    const hidden = hiddenAuditEvents(canViewCosts(ability));
    if (hidden) filters.push(hidden);

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

  /** Spec 0021, AC-11: the categories with their types; COSTS left out without ticket.costs.view. */
  findAuditCatalog(ability: AppAbility) {
    return auditCatalog(canViewCosts(ability));
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

  /**
   * formatTicket plus each linked entry's typical hours, for one ticket (spec 0007, AC-27). The
   * edit endpoints (spec 0019) answer with it too, so every write returns the same shape.
   */
  async present(ticket: TicketRow, ability: AppAbility) {
    const issues = ticket.issues;
    const entryIds = [
      ...new Set(
        issues.flatMap((i) => (i.knowledgeEntryId ? [i.knowledgeEntryId] : [])),
      ),
    ];
    const [stats, lastRejection, photoCounts, expediteRequests] =
      await Promise.all([
        loadStats(
          this.prisma,
          entryIds,
          this.settings.get('knowledge.min_samples'),
        ),
        this.lastRejection(ticket),
        livePhotoCounts(this.prisma, ticket.id),
        // Spec 0029 (child 0003), AC-18: the banner's waiting BMS requests
        waitingExpedites(this.prisma, ticket.id),
      ]);
    const hours = new Map(
      entryIds.map((id) => [id, stats.get(id)?.typicalHours ?? null]),
    );
    return {
      ...this.formatTicket(ticket, ability, hours),
      // Single ticket responses only; list rows carry neither (spec 0014, AC-13, AC-14)
      moves: this.movesOut(ticket, ability, photoCounts),
      lastRejection,
      // Spec 0018: whether work has started decides the photo strip's group order (AC-16)
      workStartedAt: ticket.workStartedAt?.toISOString() ?? null,
      expediteRequests,
    };
  }

  /** AC-14: the Send back still in force, shown only while the ticket is In progress or On hold. */
  private async lastRejection(ticket: TicketRow) {
    if (
      ticket.repairStatus !== RepairStatus.IN_PROGRESS &&
      ticket.repairStatus !== RepairStatus.ON_HOLD
    ) {
      return null;
    }
    const rows = await this.prisma.auditLog.findMany({
      where: { repairTicketId: ticket.id, action: 'STATUS_CHANGE' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        changes: true,
        note: true,
        actorName: true,
        actorEmail: true,
        createdAt: true,
      },
      // The scan stops at the newest send or send back; hold moves in between are the only
      // rows it skips, so a short window is enough
      take: REJECTION_SCAN_ROWS,
    });
    return lastRejectionFrom(rows);
  }

  /** The moves the web app offers: the status endpoint moves this caller may make now (AC-13). */
  private movesOut(
    ticket: TicketRow,
    ability: AppAbility,
    photoCounts: PhotoCounts,
  ) {
    const knowledgeOn = this.settings.isModuleOn('knowledge');
    const switches = this.photoSwitches();
    return movesFor(ticket, ability).map((m) => {
      const need = m.needs?.[0] ?? null;
      // Spec 0015, AC-5: the close needs costs while the setting is on and none are recorded
      const costsNeeded =
        m.to === RepairStatus.CLOSED &&
        this.settings.get('tickets.require_costs_to_close') &&
        !hasCosts(ticket);
      return {
        to: m.to,
        label: m.label!,
        kind: m.kind,
        needs: costsNeeded
          ? 'costs'
          : need === 'resolutions' && !knowledgeOn
            ? null
            : need,
        // Spec 0018: a photo can't be added inside the move dialog, so it is not a need; the
        // same check as the server's (AC-4 to AC-6)
        blockedBy: photoNeedUnmet(m, switches, photoCounts),
      };
    });
  }

  /** Spec 0018, AC-4 to AC-6: the three photo switches, read per request. */
  private photoSwitches(): PhotoSwitches {
    return {
      requireBeforeToStart: this.settings.get(
        'tickets.require_before_photo_to_start',
      ),
      requireAfterToSend: this.settings.get(
        'tickets.require_after_photo_to_send',
      ),
      requireAfterToClose: this.settings.get(
        'tickets.require_after_photo_to_close',
      ),
    };
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
      // Spec 0029, AC-16: the ticket page asks for the truck's upcoming trips by it
      vehicleId: ticket.vehicleId,
      vehiclePlate: ticket.vehicle.plateNumber,
      vehicleModel: ticket.vehicle.model,
      // Spec 0029, AC-12: both null on a ticket opened from a VMMS referral
      driverName: ticket.driver?.name ?? null,
      fromVmmsWorkOrder: ticket.referrals?.[0]?.workOrderNumber ?? null,
      // Spec 0029, AC-35: worked out on read, never stored. An open ticket whose truck VMMS
      // removed; the Admin cancels it, or VMMS reactivates the truck and the sync clears it
      truckRemoved: open && !ticket.vehicle.isActive,
      // Spec 0029, AC-36: the outside shop the ticket went to, picked from VMMS's list. A ticket
      // outsourced before the picker existed has none, and the detail page asks for one
      outsideShopName: ticket.outsideShopName,
      needsOutsideShop:
        atOutsideShop(ticket.repairStatus) && !ticket.vmmsProviderId,
      // Spec 0019, AC-4: so the details edit can tell a swap from the same driver
      driverId: ticket.driverId,
      garageLocation: ticket.garage.name,
      odometerReading: ticket.odometer,
      priority: ticket.priority,
      dueAt: ticket.dueAt?.toISOString() ?? null,
      dueAtSource: ticket.dueAtSource,
      // Spec 0030, AC-11: the browser can't read settings, so it compares this with its fetch time
      dueSoonAt:
        dueSoonAt(
          ticket,
          this.settings.get('tickets.due_soon_hours'),
        )?.toISOString() ?? null,
      reportedByName: ticket.reportedByName,
      // Spec 0016, AC-4: null on tickets made before they were stored
      accountType: ticket.accountType,
      corporation: ticket.corporation,
      verifiedByName: ticket.verifiedByName,
      verifiedAt: ticket.verifiedAt?.toISOString() ?? null,
      // Spec 0019, AC-19: the last edit after create; null until someone edits
      editedAt: ticket.editedAt?.toISOString() ?? null,
      editedByName: ticket.editedByName,
      issueDescription:
        ticket.issues && ticket.issues.length > 0
          ? ticket.issues.map((i) => i.description).join(', ')
          : '',
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      lastActivityAt: ticket.lastActivityAt.toISOString(),
      statusChangedAt: ticket.statusChangedAt.toISOString(),
      closedAt: ticket.closedAt?.toISOString() ?? null,
      cancellationReason: ticket.cancellationReason,
      remarks: ticket.remarks,
      issues: ticket.issues.map((i) => formatIssue(i, typicalHours)),
      // Built from TicketAssignment, so callers see the same list as before (AC-5)
      mechanics: ticket.assignments.map((a) => ({
        id: a.mechanic.id,
        name: a.mechanic.name,
      })),
      // Spec 0019, AC-13: the dashboard's "No mechanic" item reads it from list rows
      mechanicCount: ticket.assignments.length,
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
        assign: ability.can('assign', target),
        // Spec 0019, AC-1: the details and issue Edit controls
        edit: ability.can('edit', target),
        // Spec 0023, AC-2: the Edit steps and Add steps controls
        editChecklist: ability.can('editChecklist', target),
        // Spec 0030, AC-8 and AC-14: the Change control on the Due row, open tickets only
        editDueDate: open && ability.can('editDueDate', target),
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
        driverIsVerified: ticket.driver?.isVerified,
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

/** Spec 0029, AC-36: the statuses where the truck is at an outside shop. */
export function atOutsideShop(status: RepairStatus): boolean {
  return (
    status === RepairStatus.OUTSOURCED ||
    status === RepairStatus.PENDING_APPROVAL
  );
}

/** Spec 0029, AC-8: someone already opened, added or rejected this referral. */
export const referralAlreadyDecided = () =>
  new ConflictException({
    statusCode: 409,
    code: 'REFERRAL_ALREADY_DECIDED',
    message: 'This referral was already handled.',
  });
