import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RepairStatus, UserRole, VehicleStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { CreateRepairDto } from './dto/create-repair.dto';
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

const TERMINAL_STATUSES: RepairStatus[] = [
  RepairStatus.COMPLETED,
  RepairStatus.CANCELLED,
];

// ── Helper ────────────────────────────────────────────────────────────────────

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
      },
      include: this.ticketInclude(),
    });

    this.logger.log(`Repair ticket created — ${repairNumber} by ${user.email}`);
    return this.formatTicket(ticket, false);
  }

  // ── List repair tickets ──────────────────────────────────────────────────

  async findAll(
    search: string | undefined,
    status: RepairStatus | undefined,
    page: number | undefined,
    limit: number | undefined,
    user: JwtUser,
  ) {
    const isMechanic = this.isMechanic(user);
    const mechanicRecord = isMechanic ? await this.getMechanicForUser(user) : null;

    const where: Record<string, any> = {};

    if (status) {
      where.repairStatus = status;
    }

    if (search) {
      where.OR = [
        { repairNumber: { contains: search, mode: 'insensitive' } },
        { vehicle: { plateNumber: { contains: search, mode: 'insensitive' } } },
        { driver: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (isMechanic && mechanicRecord) {
      where.mechanics = { some: { id: mechanicRecord.id } };
    }

    const total = await this.prisma.repairTicket.count({ where });

    const queryOptions: any = {
      where,
      include: this.ticketInclude(),
      orderBy: [
        { completedAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'desc' },
      ],
    };

    if (page !== undefined && limit !== undefined) {
      queryOptions.skip = (page - 1) * limit;
      queryOptions.take = limit;
    }

    const tickets = await this.prisma.repairTicket.findMany(queryOptions);

    const formattedData = tickets.map((t) => this.formatTicket(t, isMechanic));
    return { data: formattedData, total };
  }

  // ── Repair history (completed + cancelled) ───────────────────────────────

  async findHistory(
    search: string | undefined,
    status: RepairStatus | undefined,
    page: number | undefined,
    limit: number | undefined,
    user: JwtUser,
  ) {
    const isMechanic = this.isMechanic(user);
    const mechanicRecord = isMechanic ? await this.getMechanicForUser(user) : null;

    const where: Record<string, any> = {
      repairStatus: status && TERMINAL_STATUSES.includes(status) ? status : { in: TERMINAL_STATUSES },
    };

    if (search) {
      where.OR = [
        { repairNumber: { contains: search, mode: 'insensitive' } },
        { vehicle: { plateNumber: { contains: search, mode: 'insensitive' } } },
        { driver: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (isMechanic && mechanicRecord) {
      where.mechanics = { some: { id: mechanicRecord.id } };
    }

    const total = await this.prisma.repairTicket.count({ where });

    const queryOptions: any = {
      where,
      include: this.ticketInclude(),
      orderBy: { completedAt: 'desc' },
    };

    if (page !== undefined && limit !== undefined) {
      queryOptions.skip = (page - 1) * limit;
      queryOptions.take = limit;
    }

    const tickets = await this.prisma.repairTicket.findMany(queryOptions);

    const formattedData = tickets.map((t) => this.formatTicket(t, isMechanic));
    return { data: formattedData, total };
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

    // When completing or cancelling, revert vehicle status
    if (
      dto.status === RepairStatus.COMPLETED ||
      dto.status === RepairStatus.CANCELLED
    ) {
      updateData.completedAt = new Date();
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

    // Write audit log entry for status change
    const auditEntry = {
      repairTicketId: id,
      userId: user.sub,
      email: user.email,
      action: 'STATUS_CHANGE',
      fieldName: 'repairStatus',
      previousValue: currentStatus,
      newValue: nextStatus,
    };

    const [updated] = await this.prisma.$transaction([
      this.prisma.repairTicket.update({
        where: { id },
        data: updateData,
        include: this.ticketInclude(),
      }),
      this.prisma.auditLog.create({ data: auditEntry }),
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

  // ── Find all audit logs across all tickets ───────────────────────────────

  async findAllAuditLogs() {
    const logs = await this.prisma.auditLog.findMany({
      include: {
        repairTicket: {
          select: {
            id: true,
            repairNumber: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return logs.map((log) => ({
      id: log.id,
      user: log.email,
      action: this.formatAuditAction(log),
      timestamp: log.createdAt.toISOString(),
      ticketId: log.repairTicket?.id || null,
    }));
  }

  private formatAuditAction(log: any): string {
    const ticketNum = log.repairTicket?.repairNumber ?? 'Unknown ticket';
    if (log.action === 'STATUS_CHANGE') {
      return `Changed status of ${ticketNum} from ${log.previousValue || 'PENDING'} to ${log.newValue}`;
    }
    if (log.action === 'COST_UPDATE') {
      return `Updated costs for ${ticketNum}`;
    }
    if (log.action === 'UNLOCK') {
      return `Unlocked ${ticketNum} (Reason: ${log.newValue})`;
    }
    if (log.action === 'SHOP_CHANGE') {
      return `Changed shop for ${ticketNum} from "${log.previousValue}" to "${log.newValue}"`;
    }
    return `${log.action} on ${ticketNum}`;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private isMechanic(user: JwtUser): boolean {
    return user.roles.some(
      (r) => r.role === UserRole.MECHANIC && r.system === user.system,
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
      shopChangeLogs: { orderBy: { changedAt: 'desc' as const } },
      auditLogs: { orderBy: { createdAt: 'desc' as const } },
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

    // Cost, audit, and admin-only fields
    if (!isMechanic) {
      return {
        ...base,
        partsCost: ticket.partsCost ? Number(ticket.partsCost) : null,
        laborCost: ticket.laborCost ? Number(ticket.laborCost) : null,
        totalCost: ticket.totalCost ? Number(ticket.totalCost) : null,
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
        shopChangeLog: ticket.shopChangeLogs.map((s: any) => ({
          changedBy: s.changedByName,
          previousValue: s.previousValue,
          newValue: s.newValue,
          changedAt: s.changedAt.toISOString(),
        })),
        auditLog: ticket.auditLogs.map((a: any) => ({
          id: a.id,
          email: a.email,
          action: a.action,
          fieldName: a.fieldName,
          previousValue: a.previousValue,
          newValue: a.newValue,
          createdAt: a.createdAt.toISOString(),
        })),
      };
    }

    return base;
  }
}
