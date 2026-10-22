import { PrismaClient, RepairStatus } from '@prisma/client';

// Simple seeded random function for reproducible organic variation
function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomStatus(): RepairStatus {
  const rand = Math.random() * 100;
  if (rand < 79) return RepairStatus.COMPLETED;          // 79% Completed
  if (rand < 87) return RepairStatus.IN_PROGRESS;        // 8% In Progress
  if (rand < 93) return RepairStatus.PENDING;            // 6% Pending
  if (rand < 97) return RepairStatus.FOR_VERIFICATION;   // 4% For Verification
  return RepairStatus.CANCELLED;                          // 3% Cancelled
}

export async function seedRepairs(prisma: PrismaClient) {
  console.log('Generating 5,419 realistic randomized historical repair tickets...');

  const garages = await prisma.garage.findMany();
  const vehicles = await prisma.vehicle.findMany();
  const drivers = await prisma.driver.findMany();
  
  const vrmsAdminUser = await prisma.user.findFirstOrThrow({
    where: { email: 'vrms.admin@welinc.com' }
  });
  
  const mechanics = await prisma.mechanic.findMany({
    where: {
      user: {
        roles: {
          some: {
            role: 'MECHANIC',
            system: 'VRMS'
          }
        }
      }
    }
  });

  const templates = [
    { cat: 'Brakes', desc: '[Brakes] Metal grinding and squeal sound under braking', part: 'Brake Pad Set (Front & Rear)', baseCost: 3450 },
    { cat: 'Brakes', desc: '[Brakes] Brake pedal feels spongy and soft during stops', part: 'Brake Fluid Flush & DOT4 Supply', baseCost: 480 },
    { cat: 'Brakes', desc: '[Brakes] Rotor surface warping causing wheel vibration', part: 'Brake Rotor Pair High-Carbon', baseCost: 6850 },
    { cat: 'Engine', desc: '[Engine] High coolant temperature engine warning indicator', part: 'Radiator Hose & Heavy Duty Coolant', baseCost: 1950 },
    { cat: 'Engine', desc: '[Engine] Low oil pressure warning light triggered on highway', part: 'Fully Synthetic Engine Oil 5L + Filter', baseCost: 2850 },
    { cat: 'Engine', desc: '[Engine] Air intake clogged, engine misfiring under load', part: 'Heavy Duty Air Filter Element', baseCost: 1350 },
    { cat: 'Engine', desc: '[Engine] Fuel injector clogged causing rough idling', part: 'Fuel Injector Cleaner & Nozzle Servicing', baseCost: 4200 },
    { cat: 'Electrical', desc: '[Electrical] 12V Battery failing cold crank test', part: '12V Maintenance Free Commercial Battery', baseCost: 5800 },
    { cat: 'Electrical', desc: '[Electrical] Alternator failing to charge battery system', part: 'OEM Heavy Duty Alternator Assembly', baseCost: 8900 },
    { cat: 'Electrical', desc: '[Electrical] Left headlight bulb assembly burned out', part: 'Halogen Headlight Bulb Pair', baseCost: 850 },
    { cat: 'Electrical', desc: '[Electrical] Starter motor clicking but not engaging', part: 'Starter Motor Solenoid Repair Kit', baseCost: 3600 },
    { cat: 'Transmission', desc: '[Transmission] Transmission slipping when shifting gear 2 to 3', part: 'ATF Synthetic Transmission Fluid 4L', baseCost: 3950 },
    { cat: 'Transmission', desc: '[Transmission] Clutch pedal sticking near floorboard', part: 'Clutch Master Cylinder Assembly', baseCost: 4400 },
    { cat: 'Transmission', desc: '[Transmission] Gear shifting stiff during heavy cargo haul', part: 'Gearbox Fluid Replacement 80W-90', baseCost: 2300 },
    { cat: 'Suspension', desc: '[Suspension] Front leaf spring squeaking over bumps', part: 'Polyurethane Leaf Spring Bushing Kit', baseCost: 1650 },
    { cat: 'Suspension', desc: '[Suspension] Rear shock absorber leaking hydraulic fluid', part: 'Heavy Duty Gas Shock Absorber Pair', baseCost: 4200 },
    { cat: 'Suspension', desc: '[Suspension] Wheel alignment drifting pulling to the right', part: 'Front End Suspension Alignment Service', baseCost: 1800 },
    { cat: 'Cooling', desc: '[Cooling] Water pump bearing noise and minor leakage', part: 'Water Pump Assembly & Gasket', baseCost: 5100 },
    { cat: 'Steering', desc: '[Steering] Power steering fluid reservoir level drop', part: 'Power Steering Pressure Hose & Fluid', baseCost: 1750 },
  ];

  const TOTAL_TARGET = 527; // Realistic organic number (~500 repairs)
  const BATCH_SIZE = 500;

  let createdCount = 0;
  const startDate = new Date('2025-01-05T08:00:00.000Z');
  const endDate = new Date('2026-08-06T17:00:00.000Z');
  const timeSpan = endDate.getTime() - startDate.getTime();

  for (let batchStart = 0; batchStart < TOTAL_TARGET; batchStart += BATCH_SIZE) {
    const batchData: any[] = [];
    const batchLimit = Math.min(batchStart + BATCH_SIZE, TOTAL_TARGET);

    for (let i = batchStart; i < batchLimit; i++) {
      const template = templates[randomBetween(0, templates.length - 1)];
      const vehicle = vehicles[randomBetween(0, vehicles.length - 1)];
      const driver = drivers[randomBetween(0, drivers.length - 1)];
      const garage = garages[randomBetween(0, garages.length - 1)];
      const status = getRandomStatus();

      // Random timestamp between Jan 2025 and Aug 2026
      const randomProgress = (i + Math.random()) / TOTAL_TARGET;
      const createdTime = new Date(startDate.getTime() + randomProgress * timeSpan);
      
      const yyyymmdd = createdTime.toISOString().slice(0, 10).replace(/-/g, '');
      const seqStr = String(i + 1).padStart(5, '0');
      const repairNumber = `REP-${yyyymmdd}-${seqStr}`;

      const isClosed = status === RepairStatus.COMPLETED;
      const hoursToComplete = randomBetween(1, 48);
      const completedTime = isClosed ? new Date(createdTime.getTime() + hoursToComplete * 3600 * 1000) : null;

      // Realistic cost variation (+/- 20% random scatter)
      const costMultiplier = 0.85 + Math.random() * 0.35;
      const partsCost = isClosed ? Math.round(template.baseCost * costMultiplier) : 0;
      const laborCost = isClosed ? Math.round(partsCost * (0.35 + Math.random() * 0.25)) : 0;
      const totalCost = partsCost + laborCost;

      batchData.push({
        repairNumber,
        repairStatus: status,
        vehicleId: vehicle.id,
        driverId: driver.id,
        garageId: garage.id,
        odometer: vehicle.odometer + randomBetween(50, 18000),
        remarks: `Driver ${driver.name} reported: ${template.desc}`,
        targetDueDate: new Date(createdTime.getTime() + randomBetween(24, 72) * 3600 * 1000),
        partsCost,
        laborCost,
        totalCost,
        createdAt: createdTime,
        updatedAt: isClosed ? completedTime! : new Date(createdTime.getTime() + randomBetween(1, 24) * 3600 * 1000),
        completedAt: completedTime,
      });
    }

    // Execute bulk create
    await prisma.repairTicket.createMany({
      data: batchData,
      skipDuplicates: true,
    });

    createdCount += batchData.length;
    console.log(`  Seeded ${createdCount} / ${TOTAL_TARGET} randomized repair tickets...`);
  }

  console.log(`\n  ✅ Successfully seeded ${TOTAL_TARGET} realistic randomized tickets into welinc_vrms_db!\n`);
}
