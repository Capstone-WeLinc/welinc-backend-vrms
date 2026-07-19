import {
  PrismaClient,
  MaintenanceStatus,
  AccountType,
  MaintenanceTriggerType,
  MaintenanceIntervalType,
} from '@prisma/client';

export async function seedVmms(prisma: PrismaClient) {
  console.log('Creating checklist templates for VMMS...');

  // Fetch relations from DB
  const garages = await prisma.garage.findMany();
  const vehicles = await prisma.vehicle.findMany();
  const mechanics = await prisma.mechanic.findMany();

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

  const oilChangeTemplate = seededTemplates.find(t => t.type === 'Oil Change');
  const brakeInspectionTemplate = seededTemplates.find(t => t.type === 'Brake Inspection');
  const generalInspectionTemplate = seededTemplates.find(t => t.type === 'General Inspection');

  const staRosaGarage = garages.find(g => g.name === 'Sta. Rosa');
  const marikinaGarage = garages.find(g => g.name === 'Marikina');

  const maintenanceSchedulesData = [
    {
      vehicleId: vehicles[0].plateNumber, // ABC-1234
      title: oilChangeTemplate?.type ?? 'Oil Change',
      status: MaintenanceStatus.PENDING,
      createdAt: new Date('2026-06-22T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name, // Juan dela Cruz
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: oilChangeTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 45000,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 10000,
      bufferDistanceKm: 500,
      startingReferenceReadingKm: 40000,
    },
    {
      vehicleId: vehicles[1].plateNumber, // XYZ-5678
      title: brakeInspectionTemplate?.type ?? 'Brake Inspection',
      status: MaintenanceStatus.IN_PROGRESS,
      createdAt: new Date('2026-06-19T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name, // Pedro Santos
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: brakeInspectionTemplate?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 72500,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 15000,
      startingReferenceReadingKm: 60000,
    },
    {
      vehicleId: vehicles[2].plateNumber, // DEF-9012
      title: generalInspectionTemplate?.type ?? 'General Inspection',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-06-14T00:00:00.000Z'),
      assignedMechanic: mechanics[1].name, // Pedro Santos
      accountType: AccountType.OUTSOURCED,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 32000,
      triggerType: MaintenanceTriggerType.MANUAL,
    },
    {
      vehicleId: vehicles[3].plateNumber, // GHI-3456
      title: generalInspectionTemplate?.type ?? 'General Inspection',
      status: MaintenanceStatus.COMPLETED,
      createdAt: new Date('2026-06-15T00:00:00.000Z'),
      assignedMechanic: mechanics[3].name, // Isabel Reyes
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: staRosaGarage?.id,
      odometerReading: 18500,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.MONTHLY,
      startReferenceDate: new Date('2026-06-01T00:00:00.000Z'),
    },
    {
      vehicleId: vehicles[4].plateNumber, // JKL-7890
      title: seededTemplates.find(t => t.type === 'Engine Tune-up')?.type ?? 'Engine Tune-up',
      status: MaintenanceStatus.OVERDUE,
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
      assignedMechanic: mechanics[0].name, // Juan dela Cruz
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: seededTemplates.find(t => t.type === 'Engine Tune-up')?.id,
      garageId: marikinaGarage?.id,
      odometerReading: 92200,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 20000,
      bufferDistanceKm: 1000,
      startingReferenceReadingKm: 70000,
    },
    {
      vehicleId: vehicles[5].plateNumber, // MNO-1122
      title: generalInspectionTemplate?.type ?? 'General Inspection',
      status: MaintenanceStatus.PENDING,
      createdAt: new Date('2026-06-28T00:00:00.000Z'),
      assignedMechanic: mechanics[4].name, // Carl Santos
      accountType: AccountType.IN_HOUSE,
      checklistTemplateId: generalInspectionTemplate?.id,
      garageId: garages[2].id, // Pulilan
      odometerReading: 145100,
      triggerType: MaintenanceTriggerType.MANUAL,
    },
  ];

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
