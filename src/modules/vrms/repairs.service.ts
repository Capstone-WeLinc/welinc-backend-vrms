import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RepairStatus, UserRole, VehicleStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import {
  ActorUser,
  AuditEvent,
  decodeCursor,
  emailKey,
  encodeCursor,
  olderThan,
  toAuditEvent,
} from './audit-events';
import { AuditEventsQueryDto } from './dto/audit-events-query.dto';
import { CreateRepairDto } from './dto/create-repair.dto';
import { FindRepairsQueryDto } from './dto/find-repairs-query.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { UpdateRepairStatusDto } from './dto/update-repair-status.dto';
import { UpdateCostsDto } from './dto/update-costs.dto';
import { UnlockTicketDto } from './dto/unlock-ticket.dto';


// ── Types ─────────────────────────────────────────────────────────────────────

type JwtUser = {
  sub: string;
  email: string;
  roles: { role: UserRole; system: string }[];
  system: string;
};

// Allowed status transitions per role
const MECHANIC_ALLOWED_TRANSITIONS: RepairStatus[] = [
  RepairStatus.PENDING,
  RepairStatus.IN_PROGRESS,
  RepairStatus.FOR_VERIFICATION,
];

const OPEN_STATUSES: RepairStatus[] = [
  RepairStatus.PENDING,
  RepairStatus.IN_PROGRESS,
  RepairStatus.FOR_VERIFICATION,
];

const TERMINAL_STATUSES: RepairStatus[] = [
  RepairStatus.COMPLETED,
  RepairStatus.CANCELLED,
];

const AUDIT_PAGE_SIZE = 50;

const LIST_PAGE_SIZE = 20;

// ── Helper ────────────────────────────────────────────────────────────────────

/** Validated `from` (inclusive) and `to` (exclusive) instants; `from >= to` is a 400. */
function parseRange(from: string | undefined, to: string | undefined) {
  const range = { from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined };
  if (range.from && range.to && range.from >= range.to) {
    throw new BadRequestException('"from" must be before "to"');
  }
  return range;
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

@Injectable()
export class RepairsService {
  private readonly logger = new Logger(RepairsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Create repair ticket ─────────────────────────────────────────────────

  async create(dto: CreateRepairDto, user: JwtUser) {
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
      throw new BadRequestException(`Vehicle with plate number "${dto.vehiclePlate}" not found`);
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
      throw new BadRequestException(`Garage location "${dto.garageLocation}" not found`);
    }

    // Lookup/Create: Drivers
    const licenseKey = dto.driverName.toLowerCase().replace(/\s+/g, '-').substring(0, 50);
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

    // Lookup/Create: Mechanics
    const mechanicIds: string[] = [];
    for (const m of dto.mechanics) {
      if (m.isOutsourced) {
        // Outsourced mechanic: dynamically create record if not exists
        let mechanic = await this.prisma.mechanic.findFirst({
          where: { name: m.name, isOutsourced: true },
        });
        if (!mechanic) {
          mechanic = await this.prisma.mechanic.create({
            data: {
              name: m.name,
              isOutsourced: true,
              shopName: m.shopName ?? null,
            },
          });
        }
        mechanicIds.push(mechanic.id);
      } else {
        // In-house mechanic: MUST exist in the database (pre-seeded/pre-configured)
        const mechanic = await this.prisma.mechanic.findFirst({
          where: { name: m.name, isOutsourced: false },
        });
        if (!mechanic) {
          throw new BadRequestException(`In-house mechanic "${m.name}" not found`);
        }
        mechanicIds.push(mechanic.id);
      }
    }

    // Set vehicle status to UNDER_REPAIR
    await this.prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { status: VehicleStatus.UNDER_REPAIR },
    });

    // Create the repair ticket with issues
    const ticket = await this.prisma.repairTicket.create({
      data: {
        repairNumber,
        vehicleId: vehicle.id,
        driverId: driver.id,
        garageId: garage.id,
        odometer: dto.odometerReading,
        repairStatus: RepairStatus.PENDING,
        issues: {
          create: dto.issues.map((issue) => ({
            description: `[${issue.vehicleSystem}] ${issue.rootCause}: ${issue.description}`,
          })),
        },
        mechanics: {
          connect: mechanicIds.map((id) => ({ id })),
        },
        // Nested so the ticket and its CREATED row are saved together or not at all
        auditLogs: {
          create: { userId: user.sub, email: user.email, action: 'CREATED' },
        },
      },
      include: this.ticketInclude(),
    });

    this.logger.log(`Repair ticket created — ${repairNumber} by ${user.email}`);
    // Auto-embed new issues into pgvector for AI Knowledge Base (fire-and-forget)
    this.autoEmbedIssues(ticket).catch(() => {});
    return this.formatTicket(ticket, false);
  }

  private async autoEmbedIssues(ticket: any): Promise<void> {
    const AI_SERVICE = process.env.AI_SERVICE_URL || 'http://vrms-analytics-ai:8020';
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
        } as any);
      } catch (e) {
        this.logger.warn(`Auto-embed failed for issue ${issue.id}: ${e}`);
      }
    }
  }

  // ── List repair tickets ──────────────────────────────────────────────────

  async findAll(query: FindRepairsQueryDto, user: JwtUser) {
    const { search, status, garageId, overdue } = query;
    const isMechanic = this.isMechanic(user);
    const mechanicRecord = isMechanic ? await this.getMechanicForUser(user) : null;

    // Fail closed: a mechanic login with no mechanic record sees nothing
    if (isMechanic && !mechanicRecord) return { data: [], total: 0 };

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

    // A mechanic is always scoped to their own tickets; mechanicId is an admin filter
    const mechanicId = mechanicRecord?.id ?? query.mechanicId;
    if (mechanicId) where.mechanics = { some: { id: mechanicId } };

    // Overdue only ever matches open tickets, whatever status was asked for
    if (overdue) {
      where.AND = [
        { repairStatus: { in: OPEN_STATUSES } },
        { targetDueDate: { lt: new Date() } },
      ];
    }

    // Neither page nor limit: every row, as the dashboard expects. One of them: the other defaults
    const paged = query.page !== undefined || query.limit !== undefined;
    const page = query.page ?? 1;
    const limit = query.limit ?? LIST_PAGE_SIZE;

    const [total, tickets] = await Promise.all([
      this.prisma.repairTicket.count({ where }),
      this.prisma.repairTicket.findMany({
        where,
        include: this.ticketInclude(),
        // Most urgent first; id last so pages never repeat or skip a row
        orderBy: [
          { targetDueDate: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        ...(paged && { skip: (page - 1) * limit, take: limit }),
      }),
    ]);

    return { data: tickets.map((t) => this.formatTicket(t, isMechanic)), total };
  }

  // ── Repair history (completed + cancelled) ───────────────────────────────

  async findHistory(query: HistoryQueryDto, user: JwtUser) {
    const { search, status, garageId, page, limit } = query;
    const { from, to } = parseRange(query.from, query.to);
    const isMechanic = this.isMechanic(user);
    const mechanicRecord = isMechanic ? await this.getMechanicForUser(user) : null;

    // Fail closed: a mechanic login with no mechanic record sees nothing
    if (isMechanic && !mechanicRecord) {
      return { data: [], total: 0, summary: { closed: 0, completed: 0, cancelled: 0, spend: null } };
    }

    // One where for rows, count and summary, so a tile never disagrees with the list
    const where: Prisma.RepairTicketWhereInput = {
      repairStatus: status ?? { in: TERMINAL_STATUSES },
    };

    if (search) {
      where.OR = [
        { repairNumber: { contains: search, mode: 'insensitive' } },
        { vehicle: { plateNumber: { contains: search, mode: 'insensitive' } } },
        { driver: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (garageId) where.garageId = garageId;
    if (from || to) where.completedAt = { ...(from && { gte: from }), ...(to && { lt: to }) };
    if (mechanicRecord) where.mechanics = { some: { id: mechanicRecord.id } };

    const [tickets, groups] = await Promise.all([
      this.prisma.repairTicket.findMany({
        where,
        select: {
          id: true,
          repairNumber: true,
          repairStatus: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          cancellationReason: true,
          isUnlocked: true,
          totalCost: true,
          vehicle: { select: { plateNumber: true, model: true } },
          driver: { select: { name: true } },
          garage: { select: { name: true } },
        },
        orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        ...(page !== undefined && limit !== undefined && { skip: (page - 1) * limit, take: limit }),
      }),
      this.prisma.repairTicket.groupBy({
        by: ['repairStatus'],
        where,
        _count: { _all: true },
        _sum: { totalCost: true },
      }),
    ]);

    const completedGroup = groups.find((g) => g.repairStatus === RepairStatus.COMPLETED);
    const completed = completedGroup?._count._all ?? 0;
    const cancelled = groups.find((g) => g.repairStatus === RepairStatus.CANCELLED)?._count._all ?? 0;

    const data = tickets.map((t) => {
      const closedAt = t.completedAt?.toISOString() ?? null;
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
        completedAt: closedAt,
        closedAt,
        cancellationReason: t.cancellationReason,
        isUnlocked: t.isUnlocked,
      };
      return isMechanic ? row : { ...row, totalCost: t.totalCost ? Number(t.totalCost) : null };
    });

    return {
      data,
      total: completed + cancelled,
      summary: {
        closed: completed + cancelled,
        completed,
        cancelled,
        spend: isMechanic ? null : Number(completedGroup?._sum.totalCost ?? 0),
      },
    };
  }

  // ── Single repair ticket ─────────────────────────────────────────────────

  async findOne(id: string, user: JwtUser) {
    const isMechanic = this.isMechanic(user);
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: this.ticketInclude(),
    });

    if (!ticket) throw new NotFoundException('Repair ticket not found');

    // Mechanics can only view tickets they are assigned to
    if (isMechanic) {
      const mechanicRecord = await this.getMechanicForUser(user);
      const isAssigned = mechanicRecord
        ? ticket.mechanics.some((m) => m.id === mechanicRecord.id)
        : false;
      if (!isAssigned) {
        throw new ForbiddenException('You are not assigned to this repair ticket');
      }
    }

    return this.formatTicket(ticket, isMechanic);
  }

  // ── Update repair status ─────────────────────────────────────────────────

  async updateStatus(id: string, dto: UpdateRepairStatusDto, user: JwtUser) {
    const isMechanic = this.isMechanic(user);
    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: { mechanics: true, vehicle: true },
    });

    if (!ticket) throw new NotFoundException('Repair ticket not found');

    if (dto.lastUpdatedAt && ticket.updatedAt.toISOString() !== dto.lastUpdatedAt) {
      throw new ConflictException(
        'This ticket has been updated by another user. Please reload the page to see the latest changes.',
      );
    }

    // Enforce sequential transitions and prevent reversal/skipping (VR-CR-02)
    const currentStatus = ticket.repairStatus;
    const nextStatus = dto.status;

    // Terminal lock — only bypassed if Admin has explicitly unlocked the ticket
    if (TERMINAL_STATUSES.includes(currentStatus)) {
      if (!ticket.isUnlocked) {
        throw new BadRequestException(
          'Completed or Cancelled repair tickets are locked and cannot be edited. An Admin must unlock this ticket first.',
        );
      }
    }

    if (nextStatus !== currentStatus) {
      let isValidTransition = false;
      if (nextStatus === RepairStatus.CANCELLED) {
        isValidTransition = true; // Allowed from any stage by Admin (checked below)
      } else if (currentStatus === RepairStatus.PENDING && nextStatus === RepairStatus.IN_PROGRESS) {
        isValidTransition = true;
      } else if (currentStatus === RepairStatus.IN_PROGRESS && nextStatus === RepairStatus.FOR_VERIFICATION) {
        isValidTransition = true;
      } else if (currentStatus === RepairStatus.FOR_VERIFICATION && nextStatus === RepairStatus.COMPLETED) {
        isValidTransition = true;
      }

      if (!isValidTransition) {
        const STATUS_LABELS: Record<string, string> = {
          PENDING: 'Pending',
          IN_PROGRESS: 'In Progress',
          FOR_VERIFICATION: 'For Verification',
          COMPLETED: 'Completed',
          CANCELLED: 'Cancelled',
        };
        const currentLabel = STATUS_LABELS[currentStatus] || currentStatus;
        const nextLabel = STATUS_LABELS[nextStatus] || nextStatus;
        throw new BadRequestException(
          `Cannot change status from '${currentLabel}' to '${nextLabel}'. Tickets must progress in order: Pending ➔ In Progress ➔ For Verification ➔ Completed.`
        );
      }
    }

    // Mechanics can only update their own assigned tickets
    if (isMechanic) {
      const mechanicRecord = await this.getMechanicForUser(user);
      const isAssigned = mechanicRecord
        ? ticket.mechanics.some((m) => m.id === mechanicRecord.id)
        : false;
      if (!isAssigned) {
        throw new ForbiddenException('You are not assigned to this repair ticket');
      }
      // Mechanics cannot transition to COMPLETED or CANCELLED
      if (!MECHANIC_ALLOWED_TRANSITIONS.includes(dto.status)) {
        throw new ForbiddenException(
          `Mechanics cannot set status to ${dto.status}. Allowed: ${MECHANIC_ALLOWED_TRANSITIONS.join(', ')}`,
        );
      }
    }

    // Cancellation requires a reason
    if (dto.status === RepairStatus.CANCELLED && !dto.cancellationReason?.trim()) {
      throw new BadRequestException('A cancellation reason is required');
    }

    // Build update data
    const updateData: Record<string, any> = {
      repairStatus: dto.status,
      // Re-lock ticket after any edit (if it was unlocked)
      isUnlocked: false,
    };

    if (dto.cancellationReason) {
      updateData.cancellationReason = dto.cancellationReason.trim();
    }

    if (dto.failedVerificationReason) {
      updateData.failedVerificationReason = dto.failedVerificationReason.trim();
    }

    if (dto.remarks?.trim()) {
      updateData.remarks = dto.remarks.trim();
    }

    // Cost encoding — only allowed by Admin, and only when FOR_VERIFICATION or later
    if (!isMechanic) {
      if (dto.partsCost !== undefined) updateData.partsCost = dto.partsCost;
      if (dto.laborCost !== undefined) updateData.laborCost = dto.laborCost;
      if (dto.partsCost !== undefined || dto.laborCost !== undefined) {
        const parts = dto.partsCost ?? Number(ticket.partsCost ?? 0);
        const labor = dto.laborCost ?? Number(ticket.laborCost ?? 0);
        updateData.totalCost = parts + labor;
      }
    }

    const statusChanged = nextStatus !== currentStatus;

    // completedAt is the close time: set only on a real change into a closed status,
    // so saving an unlocked closed ticket never re-dates it
    if (statusChanged && TERMINAL_STATUSES.includes(nextStatus)) {
      updateData.completedAt = new Date();
    }

    // When completing or cancelling, revert vehicle status
    if (
      dto.status === RepairStatus.COMPLETED ||
      dto.status === RepairStatus.CANCELLED
    ) {
      await this.prisma.vehicle.update({
        where: { id: ticket.vehicleId },
        data: { status: VehicleStatus.AVAILABLE },
      });
    }

    // On completion, sync odometer reading back to the master Vehicle record
    // (only if the ticket's reading is higher than the current stored value)
    if (dto.status === RepairStatus.COMPLETED) {
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
        data: updateData,
        include: this.ticketInclude(),
      }),
      ...(statusChanged
        ? [
            this.prisma.auditLog.create({
              data: {
                repairTicketId: id,
                userId: user.sub,
                email: user.email,
                action: 'STATUS_CHANGE',
                fieldName: 'repairStatus',
                previousValue: currentStatus,
                newValue: nextStatus,
              },
            }),
          ]
        : []),
    ]);

    this.logger.log(
      `Repair ticket ${ticket.repairNumber} status updated to ${dto.status} by ${user.email}`,
    );

    return this.formatTicket(updated, isMechanic);
  }

  // ── Update costs (dedicated endpoint) ────────────────────────────────────

  async updateCosts(id: string, dto: UpdateCostsDto, user: JwtUser) {
    if (this.isMechanic(user)) {
      throw new ForbiddenException('Mechanics cannot update costs');
    }

    const ticket = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: { repairParts: true },
    });

    if (!ticket) throw new NotFoundException('Repair ticket not found');

    if (dto.lastUpdatedAt && ticket.updatedAt.toISOString() !== dto.lastUpdatedAt) {
      throw new ConflictException(
        'This ticket has been updated by another user. Please reload the page to see the latest changes.',
      );
    }

    // Cost encoding only available at FOR_VERIFICATION or later
    const costAllowedStatuses: RepairStatus[] = [
      RepairStatus.FOR_VERIFICATION,
      RepairStatus.COMPLETED,
      RepairStatus.CANCELLED,
    ];
    if (!costAllowedStatuses.includes(ticket.repairStatus)) {
      throw new BadRequestException(
        'Cost encoding is only available once the ticket reaches "For Verification" status.',
      );
    }

    const isTerminal =
      ticket.repairStatus === RepairStatus.COMPLETED ||
      ticket.repairStatus === RepairStatus.CANCELLED;
    if (isTerminal && !ticket.isUnlocked) {
      throw new BadRequestException(
        'This ticket is locked. You must unlock the ticket first to edit costs.',
      );
    }

    let partsCost: number;
    const laborCost = dto.laborCost ?? Number(ticket.laborCost ?? 0);

    if (!dto.isLumpSum && (!dto.parts || dto.parts.length === 0)) {
      throw new BadRequestException('At least one part is required in itemized mode');
    }

    let partsData: { repairTicketId: string; description: string; unitCost: number; quantity: number; subtotal: number }[] = [];

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
    const previousParts = ticket.partsCost ? Number(ticket.partsCost) : null;
    const previousLabor = ticket.laborCost ? Number(ticket.laborCost) : null;

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
        },
      });

      await tx.auditLog.create({
        data: {
          repairTicketId: id,
          userId: user.sub,
          email: user.email,
          action: 'COST_UPDATE',
          fieldName: 'costs',
          previousValue: JSON.stringify({ partsCost: previousParts, laborCost: previousLabor }),
          newValue: JSON.stringify({ partsCost, laborCost, totalCost, isLumpSum: dto.isLumpSum }),
        },
      });
    });

    const updated = await this.prisma.repairTicket.findUnique({
      where: { id },
      include: this.ticketInclude(),
    });

    this.logger.log(`Costs updated on ticket ${ticket.repairNumber} by ${user.email}`);
    return this.formatTicket(updated!, false);
  }

  // ── List available (unoccupied) in-house mechanics ────────────────────────

  async listAvailableMechanics() {
    // Collect mechanic IDs that are assigned to any active (non-terminal) ticket
    const activeTickets = await this.prisma.repairTicket.findMany({
      where: {
        repairStatus: { notIn: [RepairStatus.COMPLETED, RepairStatus.CANCELLED] },
      },
      select: { mechanics: { select: { id: true } } },
    });

    const busyIds = activeTickets.flatMap((t) => t.mechanics.map((m) => m.id));

    return this.prisma.mechanic.findMany({
      where: {
        isOutsourced: false,
        isActive: true,
        ...(busyIds.length > 0 ? { id: { notIn: busyIds } } : {}),
      },
      select: { id: true, name: true, shopName: true },
      orderBy: { name: 'asc' },
    });
  }

  // ── Unlock terminal ticket ────────────────────────────────────────────────


  async unlockTicket(id: string, dto: UnlockTicketDto, user: JwtUser) {
    if (this.isMechanic(user)) {
      throw new ForbiddenException('Only Admins can unlock tickets');
    }

    const ticket = await this.prisma.repairTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('Repair ticket not found');

    if (!TERMINAL_STATUSES.includes(ticket.repairStatus)) {
      throw new BadRequestException('Only Completed or Cancelled tickets can be unlocked');
    }

    if (ticket.isUnlocked) {
      throw new BadRequestException('This ticket is already unlocked');
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.repairTicket.update({
        where: { id },
        data: {
          isUnlocked: true,
          unlockReason: dto.unlockReason.trim(),
        },
        include: this.ticketInclude(),
      }),
      this.prisma.auditLog.create({
        data: {
          repairTicketId: id,
          userId: user.sub,
          email: user.email,
          action: 'UNLOCK',
          newValue: dto.unlockReason.trim(),
        },
      }),
    ]);

    this.logger.log(`Ticket ${ticket.repairNumber} unlocked by ${user.email}: ${dto.unlockReason}`);
    return this.formatTicket(updated, false);
  }

  // ── Audit timeline (keyset paged, newest first) ──────────────────────────

  async findAuditEvents(query: AuditEventsQueryDto): Promise<{ data: AuditEvent[]; nextCursor: string | null }> {
    const limit = query.limit ?? AUDIT_PAGE_SIZE;
    const { from, to } = parseRange(query.from, query.to);
    const repairNumber = query.repairNumber?.trim();

    const filters: Prisma.AuditLogWhereInput[] = [];
    if (query.type) filters.push({ action: query.type });
    if (query.actorId) {
      // The Person filter carries a VRMS user id; audit rows are matched by that user's email
      const actor = await this.prisma.user.findUnique({ where: { id: query.actorId }, select: { email: true } });
      if (!actor) return { data: [], nextCursor: null };
      filters.push({ email: { equals: actor.email, mode: 'insensitive' } });
    }
    if (from || to) filters.push({ createdAt: { ...(from && { gte: from }), ...(to && { lt: to }) } });
    if (repairNumber && repairNumber.length >= 2) {
      filters.push({ repairTicket: { repairNumber: { contains: repairNumber, mode: 'insensitive' } } });
    }
    if (query.ticketId) filters.push({ repairTicketId: query.ticketId });
    if (query.cursor) filters.push(olderThan(decodeCursor(query.cursor)));

    // One extra row tells us whether anything older remains
    const rows = await this.prisma.auditLog.findMany({
      where: { AND: filters },
      select: {
        id: true,
        action: true,
        userId: true,
        email: true,
        previousValue: true,
        newValue: true,
        createdAt: true,
        repairTicket: { select: { id: true, repairNumber: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const usersByEmail = await this.findUsersByEmail(page.map((r) => r.email));

    return {
      data: page.map((row) => toAuditEvent(row, usersByEmail)),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  async findAuditActors() {
    const rows = await this.prisma.auditLog.findMany({
      where: { email: { not: null } },
      distinct: ['email'],
      select: { email: true },
    });
    const usersByEmail = await this.findUsersByEmail(rows.map((r) => r.email));
    return [...usersByEmail.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * One batched lookup of VRMS users by email, case insensitive, keyed by lowercased email.
   * audit_logs has no relation to users, and its user_id is the auth service's id, so email is the link.
   * Soft deleted and inactive users are included: their changes are real.
   */
  private async findUsersByEmail(emails: (string | null)[]): Promise<Map<string, ActorUser>> {
    const keys = [...new Set(emails.map(emailKey).filter((k): k is string => !!k))];
    if (keys.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { OR: keys.map((key) => ({ email: { equals: key, mode: 'insensitive' as const } })) },
      select: { id: true, name: true, email: true },
    });
    return new Map(users.map((u) => [u.email.toLowerCase(), u]));
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  // A chief mechanic follows the mechanic rules on tickets until feature 17 widens it (spec 0007, AC-2).
  private isMechanic(user: JwtUser): boolean {
    return user.roles.some(
      (r) =>
        (r.role === UserRole.MECHANIC || r.role === UserRole.CHIEF_MECHANIC) &&
        r.system === user.system,
    );
  }

  private async getMechanicForUser(user: JwtUser) {
    // Find mechanic profile linked to this user account
    return this.prisma.mechanic.findFirst({
      where: { user: { email: user.email } },
    });
  }

  private ticketInclude() {
    return {
      vehicle: { select: { plateNumber: true, model: true, status: true } },
      driver: { select: { name: true, licenseNumber: true, isVerified: true } },
      garage: { select: { name: true } },
      issues: true,
      mechanics: { select: { id: true, name: true, isOutsourced: true, shopName: true } },
      repairParts: { orderBy: { createdAt: 'asc' as const } },
    };
  }

  private formatTicket(ticket: any, isMechanic: boolean) {
    const base = {
      id: ticket.id,
      repairNumber: ticket.repairNumber,
      status: ticket.repairStatus,
      vehiclePlate: ticket.vehicle.plateNumber,
      vehicleModel: ticket.vehicle.model,
      driverName: ticket.driver.name,
      garageLocation: ticket.garage.name,
      odometerReading: ticket.odometer,
      targetDueDate: ticket.targetDueDate,
      issueDescription: ticket.issues && ticket.issues.length > 0
        ? ticket.issues.map((i: any) => i.description).join(', ')
        : '',
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      completedAt: ticket.completedAt?.toISOString() ?? null,
      cancellationReason: ticket.cancellationReason,
      failedVerificationReason: ticket.failedVerificationReason,
      remarks: ticket.remarks,
      issues: ticket.issues.map((i: any) => ({
        id: i.id,
        description: i.description,
      })),
      mechanics: ticket.mechanics.map((m: any) => ({
        id: m.id,
        name: m.name,
        isOutsourced: m.isOutsourced,
        shopName: m.shopName,
      })),
    };

    // Cost and admin-only fields. A ticket's history is read from GET /vrms/repairs/audit-logs?ticketId=
    if (!isMechanic) {
      return {
        ...base,
        // != null so a stored 0 is sent as 0 (recorded), not as missing
        partsCost: ticket.partsCost != null ? Number(ticket.partsCost) : null,
        laborCost: ticket.laborCost != null ? Number(ticket.laborCost) : null,
        totalCost: ticket.totalCost != null ? Number(ticket.totalCost) : null,
        isLumpSum: ticket.isLumpSum,
        isUnlocked: ticket.isUnlocked,
        unlockReason: ticket.unlockReason,
        driverIsVerified: ticket.driver.isVerified,
        repairParts: ticket.repairParts.map((p: any) => ({
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
