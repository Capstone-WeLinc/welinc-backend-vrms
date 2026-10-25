import {
  PrismaClient,
  MaintenanceStatus,
  AccountType,
  MaintenanceTriggerType,
  MaintenanceIntervalType,
  VehicleStatus,
} from '@prisma/client';
import { VEHICLES } from './catalog';

// VMMS stores the mechanic by name; these are the in house mechanics with a login at each garage
const MAINTENANCE_CREW: Record<string, string[]> = {
  'Sta. Rosa': ['Juan dela Cruz', 'Pedro Santos'],
  Marikina: ['Rommel Cruz'],
  Pulilan: ['Isabel Reyes', 'Carl Santos'],
};

export async function seedVmms(prisma: PrismaClient, now: number) {
  console.log('Creating checklist templates for VMMS...');

  // Fetch relations from DB
  const garages = await prisma.garage.findMany();
  const vehicles = await prisma.vehicle.findMany({ orderBy: { plateNumber: 'asc' } });

  const checklistTemplatesData = [
    {
      type: 'Oil Change',
      items: [
        'Drain old engine oil',
        'Replace oil filter',
        'Fill with new engine oil',
        'Check for oil leaks',
        'Reset maintenance light',
      ],
    },
    {
      type: 'Brake Inspection',
      items: [
        'Check brake pad thickness',
        'Inspect brake rotors for wear',
        'Check brake fluid level and condition',
        'Inspect brake lines for leaks',
        'Test brake pedal feel',
      ],
    },
    {
      type: 'Tire Rotation',
      items: [
        'Check tire pressure on all tires',
        'Inspect tire tread depth',
        'Rotate tires according to pattern',
        'Torque lug nuts to specification',
        'Check alignment if irregular wear found',
      ],
    },
    {
      type: 'Engine Tune-up',
      items: [
        'Replace spark plugs',
        'Inspect ignition coils/wires',
        'Replace air filter',
        'Clean fuel injectors (if necessary)',
        'Check engine timing and idle',
      ],
    },
    {
      type: 'General Inspection',
      items: [
        'Check all fluid levels',
        'Inspect belts and hoses',
        'Test battery and charging system',
        'Check exterior and interior lights',
        'Inspect wiper blades',
      ],
    },
  ];

  const seededTemplates: any[] = [];
  for (const templateData of checklistTemplatesData) {
    const existing = await prisma.checklistTemplate.findUnique({
      where: { type: templateData.type },
    });

    if (existing) {
      await prisma.checklistItem.deleteMany({
        where: { checklistTemplateId: existing.id },
      });
    }

    const t = await prisma.checklistTemplate.upsert({
      where: { type: templateData.type },
      update: {},
      create: {
        type: templateData.type,
      },
    });

    await prisma.checklistItem.createMany({
      data: templateData.items.map((text, index) => ({
        checklistTemplateId: t.id,
        text,
        order: index,
      })),
    });

    seededTemplates.push(t);
  }

  console.log(`  Created ${seededTemplates.length} checklist templates for VMMS\n`);

  console.log('Creating sample maintenance schedules for VMMS...');

  // Clean old schedules first
  await prisma.maintenanceSchedule.deleteMany();

  const template = (type: string) => seededTemplates.find((t) => t.type === type)!;
  const garageId = new Map(garages.map((g) => [g.name, g.id]));
  const day = 24 * 3_600_000;
  const daysAgo = (n: number) => new Date(now - n * day);
  // Round down to the last full thousand, the way service intervals are booked
  const thousand = (km: number) => Math.floor(km / 1000) * 1000;

  // Only trucks that are on the road (not retired, not in for a repair) get a schedule
  const free = vehicles.filter((v) => v.isActive && v.status === VehicleStatus.AVAILABLE);
  const truck = (i: number) => free[i % free.length];
  const garageOf = (plate: string) => VEHICLES.find((v) => v.plateNumber === plate)!.garage;
  const mechanicAt = (plate: string, i = 0) => {
    const names = MAINTENANCE_CREW[garageOf(plate)];
    return names[i % names.length];
  };

  const maintenanceSchedulesData = [0, 1, 2, 3, 4, 5].map((i) => {
    const v = truck(i * 3);
    const base = {
      vehicleId: v.plateNumber,
      assignedMechanic: mechanicAt(v.plateNumber, i),
      accountType: AccountType.IN_HOUSE,
      garageId: garageId.get(garageOf(v.plateNumber)),
    };
    switch (i) {
      case 0: // next oil change coming up by odometer
        return { ...base, title: 'Oil Change', checklistTemplateId: template('Oil Change').id, status: MaintenanceStatus.PENDING,
          createdAt: daysAgo(3), odometerReading: v.odometer, triggerType: MaintenanceTriggerType.ODOMETER,
          intervalKm: 10000, bufferDistanceKm: 500, startingReferenceReadingKm: thousand(v.odometer - 6000) };
      case 1: // on the lift right now
        return { ...base, title: 'Brake Inspection', checklistTemplateId: template('Brake Inspection').id, status: MaintenanceStatus.IN_PROGRESS,
          createdAt: daysAgo(1), odometerReading: v.odometer, triggerType: MaintenanceTriggerType.ODOMETER,
          intervalKm: 15000, startingReferenceReadingKm: thousand(v.odometer - 15000) };
      case 2:
        return { ...base, title: 'General Inspection', checklistTemplateId: template('General Inspection').id, status: MaintenanceStatus.COMPLETED,
          createdAt: daysAgo(14), odometerReading: v.odometer - 1800, triggerType: MaintenanceTriggerType.MANUAL, accountType: AccountType.OUTSOURCED };
      case 3: // monthly, so completing it books the next one
        return { ...base, title: 'General Inspection', checklistTemplateId: template('General Inspection').id, status: MaintenanceStatus.COMPLETED,
          createdAt: daysAgo(20), odometerReading: v.odometer - 2600, triggerType: MaintenanceTriggerType.TIME,
          intervalType: MaintenanceIntervalType.MONTHLY, startReferenceDate: daysAgo(25) };
      case 4: // passed its interval without service
        return { ...base, title: 'Engine Tune-up', checklistTemplateId: template('Engine Tune-up').id, status: MaintenanceStatus.OVERDUE,
          createdAt: daysAgo(18), odometerReading: v.odometer, triggerType: MaintenanceTriggerType.ODOMETER,
          intervalKm: 20000, bufferDistanceKm: 1000, startingReferenceReadingKm: thousand(v.odometer - 22000) };
      default:
        return { ...base, title: 'Tire Rotation', checklistTemplateId: template('Tire Rotation').id, status: MaintenanceStatus.PENDING,
          createdAt: daysAgo(2), odometerReading: v.odometer, triggerType: MaintenanceTriggerType.MANUAL };
    }
  });

  // The truck on the lift is under maintenance
  await prisma.vehicle.update({ where: { plateNumber: truck(3).plateNumber }, data: { status: VehicleStatus.UNDER_MAINTENANCE } });

  const getNextMaintenanceDate = (date: Date, intervalType?: MaintenanceIntervalType | null) => {
    const next = new Date(date);
    switch (intervalType) {
      case MaintenanceIntervalType.DAILY:
        next.setUTCDate(next.getUTCDate() + 1);
        return next;
      case MaintenanceIntervalType.WEEKLY:
        next.setUTCDate(next.getUTCDate() + 7);
        return next;
      case MaintenanceIntervalType.MONTHLY:
        next.setUTCMonth(next.getUTCMonth() + 1);
        return next;
      case MaintenanceIntervalType.QUARTERLY:
        next.setUTCMonth(next.getUTCMonth() + 3);
        return next;
      case MaintenanceIntervalType.SEMI_ANNUALLY:
        next.setUTCMonth(next.getUTCMonth() + 6);
        return next;
      case MaintenanceIntervalType.ANNUALLY:
        next.setUTCFullYear(next.getUTCFullYear() + 1);
        return next;
      default:
        return null;
    }
  };

  const createNextSeedMaintenanceSchedule = async (completedSchedule: any) => {
    const triggerType = completedSchedule.triggerType;
    const isOdometerRecurring = triggerType === MaintenanceTriggerType.ODOMETER && completedSchedule.intervalKm != null && completedSchedule.intervalKm > 0;
    const isTimeRecurring = triggerType === MaintenanceTriggerType.TIME && Boolean(completedSchedule.intervalType);

    if (!isOdometerRecurring && !isTimeRecurring) return null;

    const nextDate = getNextMaintenanceDate((completedSchedule.startReferenceDate ?? completedSchedule.createdAt), completedSchedule.intervalType) ?? (completedSchedule.startReferenceDate ?? completedSchedule.createdAt);
    const nextOdometer = completedSchedule.odometerReading != null && completedSchedule.intervalKm != null
      ? completedSchedule.odometerReading + completedSchedule.intervalKm
      : completedSchedule.odometerReading;

    return prisma.maintenanceSchedule.create({
      data: {
        vehicleId: completedSchedule.vehicleId,
        title: completedSchedule.title,
        status: MaintenanceStatus.PENDING,
        assignedMechanic: completedSchedule.assignedMechanic,
        accountType: completedSchedule.accountType,
        checklistTemplateId: completedSchedule.checklistTemplateId,
        garageId: completedSchedule.garageId,
        odometerReading: nextOdometer,
        triggerType: completedSchedule.triggerType,
        intervalKm: completedSchedule.intervalKm,
        bufferDistanceKm: completedSchedule.bufferDistanceKm,
        startingReferenceReadingKm: completedSchedule.odometerReading,
        intervalType: completedSchedule.intervalType,
        startReferenceDate: nextDate,
        previousScheduleId: completedSchedule.id,
      },
    });
  };

  let createdMaintenanceSchedulesCount = 0;
  for (const schedule of maintenanceSchedulesData) {
    const createdSchedule = await prisma.maintenanceSchedule.create({
      data: schedule,
    });
    createdMaintenanceSchedulesCount += 1;

    if (createdSchedule.status === MaintenanceStatus.COMPLETED) {
      const nextSchedule = await createNextSeedMaintenanceSchedule(createdSchedule);
      if (nextSchedule) createdMaintenanceSchedulesCount += 1;
    }
  }

  console.log(`  Created ${createdMaintenanceSchedulesCount} sample maintenance schedules for VMMS\n`);
}
