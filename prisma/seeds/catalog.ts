import { KnowledgeEntryStatus, RepairPriority } from '@prisma/client';

// The repair problems a light and medium truck fleet in Laguna, Metro Manila and Bulacan runs into.
// Tickets, knowledge entries, parts and prices are all drawn from here, so every field agrees.
// Prices are Philippine peso ranges for Isuzu Elf, Fuso Canter and Hino 300 class trucks.

export type PartSpec = {
  name: string;
  price: [number, number];
  qty?: [number, number];
  /** Chance the part is on the bill; 1 when left out. */
  p?: number;
};

export type EntrySpec = {
  name: string;
  status: KnowledgeEntryStatus;
  symptoms: string;
  descriptionTemplate?: string;
  estimatedHours?: number;
  safetyNotes?: string;
  steps: string[];
  parts: string[];
  /** Months before today the entry was written. */
  writtenMonthsAgo: number;
  /** INACTIVE only: months before today it was deactivated. */
  deactivatedMonthsAgo?: number;
};

export type Problem = {
  key: string;
  category: string;
  priority: RepairPriority;
  /** Relative frequency across the fleet. */
  weight: number;
  laborHours: [number, number];
  rootCauses: string[];
  reports: string[];
  fixes: string[];
  parts: PartSpec[];
  entry?: EntrySpec;
  /** Only shows up in the last N days (a problem that is new to the fleet). */
  recentDays?: number;
  /** Only shows up before N days ago. */
  beforeDaysAgo?: number;
};

export const PROBLEMS: Problem[] = [
  // ── Brakes ────────────────────────────────────────────────────────────────
  {
    key: 'brake-pads',
    category: 'Brakes',
    priority: 'HIGH',
    weight: 14,
    laborHours: [1.25, 3],
    rootCauses: [
      'Front brake pads worn',
      'Brake pads worn to the backing plate',
      'Front pads below minimum thickness',
    ],
    reports: [
      'Grinding noise from the front wheels when braking, worse at low speed.',
      'Loud squeal every time the truck brakes, started after the last Bulacan run.',
      'Driver reports metal on metal sound when braking and the truck takes longer to stop.',
      'Squealing from the front left wheel when braking with a full load.',
    ],
    fixes: [
      'Replaced front pads, rotors within spec.',
      'New front pad set, cleaned and greased caliper slide pins.',
      'Replaced front pads and resurfaced both rotors, road tested OK.',
      'Pads were down to 1 mm, replaced. Rotors scored lightly, resurfaced.',
    ],
    parts: [
      { name: 'Front brake pad set', price: [2400, 3600] },
      {
        name: 'Brake rotor resurfacing',
        price: [600, 900],
        qty: [2, 2],
        p: 0.4,
      },
      { name: 'Caliper slide pin grease', price: [180, 280], p: 0.5 },
      { name: 'Brake fluid DOT3 1L', price: [380, 480], p: 0.3 },
    ],
    entry: {
      name: 'Brake pads worn',
      status: 'ACTIVE',
      symptoms:
        'Squeal or grinding when braking, longer stopping distance, brake warning light on some units. Usually the front axle first.',
      descriptionTemplate:
        'Noise when braking from the front wheels. Note which side and whether it happens loaded or empty.',
      estimatedHours: 2,
      safetyNotes:
        'Chock the rear wheels and support the axle on stands, never on the jack alone. Pump the pedal several times before the road test.',
      steps: [
        'Chock the rear wheels, loosen the lug nuts, lift the front axle and set it on stands.',
        'Remove the wheels and measure pad thickness. Replace below 3 mm.',
        'Measure rotor thickness and runout. Resurface or replace if out of spec.',
        'Clean and grease the caliper slide pins, fit the new pads with the anti squeal shims.',
        'Torque the lug nuts to spec in a star pattern.',
        'Pump the pedal until firm, check the fluid level, then road test for noise and pull.',
      ],
      parts: [
        'Front brake pad set',
        'Caliper slide pin grease',
        'Brake fluid DOT3',
      ],
      writtenMonthsAgo: 13,
    },
  },
  {
    key: 'brake-squeal-old',
    category: 'Brakes',
    priority: 'MEDIUM',
    weight: 4,
    beforeDaysAgo: 370, // the old entry was retired for "Brake pads worn"
    laborHours: [1, 2],
    rootCauses: ['Brake squeal'],
    reports: ['Brakes squeal at low speed.'],
    fixes: ['Cleaned the brake assembly and applied anti squeal paste.'],
    parts: [{ name: 'Anti squeal paste', price: [250, 380] }],
    entry: {
      name: 'Brake squeal',
      status: 'INACTIVE',
      symptoms: 'High pitched squeal at low speed when braking lightly.',
      estimatedHours: 1,
      steps: [
        'Lift and support the axle, remove the wheels.',
        'Clean the pads and caliper with brake cleaner.',
        'Apply anti squeal paste to the back of the pads and refit.',
      ],
      parts: ['Anti squeal paste'],
      writtenMonthsAgo: 15,
      deactivatedMonthsAgo: 12,
    },
  },
  {
    key: 'brake-leak',
    category: 'Brakes',
    priority: 'CRITICAL',
    weight: 4,
    laborHours: [2, 4],
    rootCauses: [
      'Rear wheel cylinder leaking',
      'Brake hose cracked',
      'Brake fluid leak at the rear drum',
    ],
    reports: [
      'Brake pedal goes almost to the floor, fluid reservoir low after two days.',
      'Wet spot of brake fluid inside the rear right tire, pedal feels soft.',
      'Brake warning light came on during the EDSA run, pedal soft and low.',
    ],
    fixes: [
      'Replaced the rear right wheel cylinder and bled the system.',
      'Front left brake hose cracked near the fitting, replaced and bled.',
      'Rear wheel cylinder leaking, replaced both sides and the soaked shoes.',
    ],
    parts: [
      { name: 'Rear wheel cylinder', price: [1600, 2600], qty: [1, 2] },
      { name: 'Brake hose', price: [650, 1100], p: 0.35 },
      { name: 'Rear brake shoe set', price: [2800, 4200], p: 0.45 },
      { name: 'Brake fluid DOT3 1L', price: [380, 480], qty: [1, 2] },
    ],
    entry: {
      name: 'Brake fluid leak at a wheel cylinder or hose',
      status: 'ACTIVE',
      symptoms:
        'Soft or sinking brake pedal, low fluid in the reservoir, wet residue on the inside of a tire or under a drum.',
      descriptionTemplate:
        'Brake pedal soft or low. Fluid level when checked, and where any wet spot is.',
      estimatedHours: 3,
      safetyNotes:
        'Do not release the truck until the pedal is firm and holds for 30 seconds. Brake fluid strips paint, wipe spills right away.',
      steps: [
        'Check the reservoir level and look for wet spots at each wheel and along the lines.',
        'Pull the drum or wheel at the leak and confirm the source: wheel cylinder, hose or line.',
        'Replace the leaking part. Replace the shoes too if they are soaked with fluid.',
        'Bleed the system starting from the wheel farthest from the master cylinder.',
        'Hold firm pedal pressure for 30 seconds and check that it does not sink.',
        'Road test with several hard stops, then check again for leaks.',
      ],
      parts: [
        'Rear wheel cylinder',
        'Brake hose',
        'Brake fluid DOT3',
        'Rear brake shoe set',
      ],
      writtenMonthsAgo: 10,
    },
  },
  {
    key: 'rotor-warp',
    category: 'Brakes',
    priority: 'MEDIUM',
    weight: 4,
    laborHours: [1.5, 3],
    rootCauses: ['Front rotors warped', 'Brake rotor runout out of spec'],
    reports: [
      'Steering wheel shakes when braking from highway speed.',
      'Pulsing in the brake pedal coming down the Antipolo road.',
      'Vibration through the floor when braking hard with a full load.',
    ],
    fixes: [
      'Both front rotors warped, replaced with new pads.',
      'Rotors resurfaced, runout now within spec, new pads fitted.',
    ],
    parts: [
      { name: 'Front brake rotor', price: [3800, 5500], qty: [2, 2], p: 0.6 },
      {
        name: 'Brake rotor resurfacing',
        price: [600, 900],
        qty: [2, 2],
        p: 0.4,
      },
      { name: 'Front brake pad set', price: [2400, 3600], p: 0.7 },
    ],
    entry: {
      name: 'Warped front brake rotors',
      status: 'ACTIVE',
      symptoms:
        'Pedal pulses or the steering wheel shakes when braking, mostly from higher speed.',
      estimatedHours: 2.5,
      steps: [
        'Lift the front axle onto stands and remove the wheels.',
        'Measure rotor runout with a dial gauge and the thickness with a micrometer.',
        'Resurface rotors that stay above minimum thickness, replace the rest.',
        'Fit new pads if the old ones are glazed or uneven.',
        'Torque the lug nuts in a star pattern and road test.',
      ],
      parts: ['Front brake rotor', 'Front brake pad set'],
      writtenMonthsAgo: 8,
    },
  },

  // ── Engine ────────────────────────────────────────────────────────────────
  {
    key: 'oil-leak',
    category: 'Engine',
    priority: 'MEDIUM',
    weight: 6,
    laborHours: [1.5, 3],
    rootCauses: ['Valve cover gasket leaking', 'Oil leak at the valve cover'],
    reports: [
      'Oil drips under the engine after parking overnight at the Sta. Rosa yard.',
      'Burning oil smell in the cab after long trips.',
      'Oil level drops about a liter a week, wet engine block on the right side.',
    ],
    fixes: [
      'Replaced the valve cover gasket and cleaned the block.',
      'Valve cover gasket hardened, replaced and topped up oil.',
    ],
    parts: [
      { name: 'Valve cover gasket', price: [650, 1200] },
      { name: 'RTV silicone sealant', price: [280, 380], p: 0.6 },
      { name: 'Engine oil 15W-40 1L', price: [320, 420], qty: [1, 2] },
      { name: 'Engine degreaser', price: [220, 320], p: 0.5 },
    ],
    entry: {
      name: 'Oil leak at the valve cover gasket',
      status: 'ACTIVE',
      symptoms:
        'Oil drops under the engine, burning oil smell, oil on top of the block or exhaust manifold.',
      descriptionTemplate:
        'Oil leak under the engine. How fast the level drops, and where the wet area is.',
      estimatedHours: 2,
      safetyNotes:
        'Let the engine cool first. Oil on the exhaust manifold can catch fire.',
      steps: [
        'Degrease the top of the engine and run it for 10 minutes to find the leak.',
        'Remove the valve cover and scrape the old gasket off both faces.',
        'Fit the new gasket with sealant at the corners.',
        'Torque the cover bolts in sequence to spec, do not overtighten.',
        'Top up the oil, run the engine and check for leaks.',
      ],
      parts: [
        'Valve cover gasket',
        'RTV silicone sealant',
        'Engine oil 15W-40',
      ],
      writtenMonthsAgo: 11,
    },
  },
  {
    key: 'fuel-filter',
    category: 'Engine',
    priority: 'HIGH',
    weight: 7,
    laborHours: [0.75, 1.75],
    rootCauses: ['Fuel filter clogged', 'Water in the fuel separator'],
    reports: [
      'Engine loses power going uphill and sputters under load.',
      'Water in fuel light on after refueling at a provincial station.',
      'Truck hesitates and almost stalls when accelerating with a full load.',
    ],
    fixes: [
      'Drained water from the separator, replaced the fuel filter, bled the system.',
      'Fuel filter clogged, replaced and bled. Advised driver to refuel at main stations.',
      'Replaced filter and separator element, engine pulls normally now.',
    ],
    parts: [
      { name: 'Fuel filter', price: [450, 850] },
      { name: 'Water separator element', price: [550, 900], p: 0.5 },
    ],
    entry: {
      name: 'Clogged fuel filter or water in fuel',
      status: 'ACTIVE',
      symptoms:
        'Loss of power under load, sputtering, hard starting, water in fuel warning light.',
      estimatedHours: 1,
      steps: [
        'Drain the water separator into a clear container and check for water or dirt.',
        'Replace the fuel filter and the separator element if dirty.',
        'Prime and bleed the fuel system with the hand pump until no air comes out.',
        'Start the engine and check for leaks at the filter housing.',
        'Road test uphill with a load.',
      ],
      parts: ['Fuel filter', 'Water separator element'],
      writtenMonthsAgo: 12,
    },
  },
  {
    key: 'glow-plug',
    category: 'Engine',
    priority: 'MEDIUM',
    weight: 3,
    laborHours: [1, 2],
    rootCauses: ['Glow plugs burned out', 'Glow plug relay failed'],
    reports: [
      'Hard to start in the early morning, lots of white smoke for the first minutes.',
      'Needs several tries to start on cold mornings.',
    ],
    fixes: [
      'Two glow plugs open circuit, replaced all four.',
      'Glow plug relay failed, replaced relay, plugs tested OK.',
    ],
    parts: [
      { name: 'Glow plug', price: [650, 1100], qty: [2, 4] },
      { name: 'Glow plug relay', price: [850, 1400], p: 0.3 },
    ],
    entry: {
      name: 'Glow plug failure, hard cold start',
      status: 'ACTIVE',
      symptoms:
        'Hard starting on cold mornings, white smoke at start, rough idle until warm.',
      estimatedHours: 1.5,
      steps: [
        'Check that the glow indicator lights and goes out when the key is turned.',
        'Test each glow plug for resistance with a multimeter.',
        'Test the glow plug relay and its fuse.',
        'Replace failed plugs, ideally the whole set, and torque them to spec.',
        'Test a start after the engine has fully cooled.',
      ],
      parts: ['Glow plug', 'Glow plug relay'],
      writtenMonthsAgo: 7,
    },
  },
  {
    key: 'injector',
    category: 'Engine',
    priority: 'HIGH',
    weight: 3,
    laborHours: [3, 6],
    rootCauses: ['Injector nozzles worn', 'Fuel injectors dripping'],
    reports: [
      'Black smoke when accelerating and fuel use is up by about a fifth.',
      'Engine knocks at idle and blows black smoke on the expressway.',
    ],
    fixes: [
      'Injectors calibrated at the diesel shop, two nozzles replaced.',
      'All four nozzles replaced and calibrated, smoke cleared.',
    ],
    parts: [
      { name: 'Injector nozzle', price: [2200, 3800], qty: [2, 4] },
      { name: 'Injector calibration', price: [3500, 5500] },
      { name: 'Injector seal washer', price: [80, 150], qty: [4, 4] },
    ],
    entry: {
      name: 'Worn injector nozzles, black smoke',
      status: 'ACTIVE',
      symptoms:
        'Black smoke under acceleration, knocking at idle, higher fuel use, rough running.',
      estimatedHours: 4,
      safetyNotes:
        'Injector lines hold very high pressure. Never loosen a line with the engine running.',
      steps: [
        'Check the air filter and intake first, a blocked filter also causes black smoke.',
        'Do a cylinder cut out test to find the weak injectors.',
        'Remove the injectors and send them for pop testing and calibration.',
        'Fit new seal washers and refit the injectors, torque to spec.',
        'Bleed the fuel lines and road test for smoke.',
      ],
      parts: ['Injector nozzle', 'Injector seal washer'],
      writtenMonthsAgo: 6,
    },
  },

  // ── Electrical ────────────────────────────────────────────────────────────
  {
    key: 'battery',
    category: 'Electrical',
    priority: 'HIGH',
    weight: 8,
    laborHours: [0.25, 1],
    rootCauses: ['Battery failed the load test', 'Battery at end of life'],
    reports: [
      'Truck will not start in the morning, only clicks.',
      'Needed a jump start twice this week at the Marikina yard.',
      'Engine cranks slowly, dashboard lights dim when cranking.',
    ],
    fixes: [
      'Battery failed the load test, replaced with a new 3SM.',
      'Replaced the battery and cleaned corroded terminals.',
      'Battery was 3 years old and weak, replaced. Charging voltage OK at 14.1 V.',
    ],
    parts: [
      { name: 'Battery 3SM maintenance free', price: [6200, 8500] },
      { name: 'Battery terminal', price: [150, 250], qty: [1, 2], p: 0.4 },
    ],
    entry: {
      name: 'Weak or dead battery',
      status: 'ACTIVE',
      symptoms:
        'No start or a clicking sound, slow cranking, dim lights when cranking, needs jump starts.',
      estimatedHours: 0.5,
      safetyNotes:
        'Disconnect the negative terminal first and connect it last. No sparks near the battery.',
      steps: [
        'Measure resting voltage and do a load test.',
        'Clean the terminals and check the ground strap.',
        'Replace the battery if it fails the load test.',
        'With the engine running, check charging voltage is 13.8 to 14.4 V.',
      ],
      parts: ['Battery 3SM maintenance free', 'Battery terminal'],
      writtenMonthsAgo: 13,
    },
  },
  {
    key: 'alternator',
    category: 'Electrical',
    priority: 'HIGH',
    weight: 4,
    laborHours: [1.5, 3],
    rootCauses: ['Alternator not charging', 'Alternator regulator failed'],
    reports: [
      'Battery light on while driving, battery dead the next morning.',
      'Headlights dim and flicker at night, battery warning light stays on.',
    ],
    fixes: [
      'Alternator rebuilt at the auto electric shop, new regulator and brushes.',
      'Replaced the alternator with a rebuilt unit and a new drive belt.',
    ],
    parts: [
      { name: 'Alternator rebuild kit', price: [2500, 4000], p: 0.6 },
      { name: 'Rebuilt alternator assembly', price: [7500, 11000], p: 0.4 },
      { name: 'Alternator drive belt', price: [650, 1200], p: 0.5 },
    ],
    entry: {
      name: 'Alternator not charging',
      status: 'ACTIVE',
      symptoms:
        'Battery warning light while driving, dim or flickering lights, battery keeps going flat.',
      estimatedHours: 2,
      steps: [
        'Check the drive belt tension and condition.',
        'Measure charging voltage at idle and at 2000 rpm.',
        'Check the alternator fuse and wiring for loose connections.',
        'Remove the alternator and send it for testing or rebuild.',
        'Refit, set the belt tension and check charging voltage again.',
      ],
      parts: ['Alternator rebuild kit', 'Alternator drive belt'],
      writtenMonthsAgo: 9,
    },
  },
  {
    key: 'starter',
    category: 'Electrical',
    priority: 'HIGH',
    weight: 3,
    laborHours: [1.5, 2.5],
    rootCauses: ['Starter solenoid failing', 'Starter motor brushes worn'],
    reports: [
      'Single click when turning the key, battery tested fine.',
      'Starter sometimes spins without engaging the engine.',
    ],
    fixes: [
      'Starter solenoid contacts burned, replaced solenoid.',
      'Starter overhauled, new brushes and solenoid.',
    ],
    parts: [
      { name: 'Starter solenoid', price: [1800, 2800] },
      { name: 'Starter brush set', price: [450, 750], p: 0.5 },
    ],
    entry: {
      name: 'Starter motor or solenoid failure',
      status: 'ACTIVE',
      symptoms:
        'Click with no crank while the battery is good, or the starter spins without engaging.',
      estimatedHours: 2,
      steps: [
        'Confirm the battery passes a load test.',
        'Check voltage at the solenoid while someone turns the key.',
        'Remove the starter and bench test it.',
        'Replace the solenoid or overhaul the starter, then refit and test several starts.',
      ],
      parts: ['Starter solenoid', 'Starter brush set'],
      writtenMonthsAgo: 5,
    },
  },
  {
    key: 'lights',
    category: 'Electrical',
    priority: 'LOW',
    weight: 5,
    laborHours: [0.25, 1],
    rootCauses: [
      'Tail light bulb burned out',
      'Blown fuse on the lighting circuit',
      'Corroded tail light socket',
    ],
    reports: [
      'Left tail light not working, flagged by the guard at the client gate.',
      'Both brake lights out.',
      'Right signal light blinks fast, front bulb out.',
    ],
    fixes: [
      'Replaced the burned bulb.',
      'Blown fuse replaced, socket cleaned.',
      'Corroded socket replaced and contacts cleaned.',
    ],
    parts: [
      { name: 'Tail light bulb 24V', price: [60, 120], qty: [1, 2] },
      { name: 'Fuse 15A', price: [25, 60], qty: [1, 3], p: 0.4 },
      { name: 'Bulb socket', price: [180, 350], p: 0.3 },
    ],
    entry: {
      name: 'Light out, bulb, fuse or socket',
      status: 'ACTIVE',
      symptoms:
        'A tail, brake, signal or head light does not work, or a signal blinks too fast.',
      estimatedHours: 0.5,
      steps: [
        'Check the bulb and replace it if the filament is broken.',
        'Check the fuse for that circuit.',
        'Clean or replace a corroded socket.',
        'Check every light works before release.',
      ],
      parts: ['Tail light bulb 24V', 'Fuse 15A', 'Bulb socket'],
      writtenMonthsAgo: 12,
    },
  },

  // ── Suspension ────────────────────────────────────────────────────────────
  {
    key: 'leaf-spring',
    category: 'Suspension',
    priority: 'HIGH',
    weight: 4,
    laborHours: [2.5, 4.5],
    rootCauses: ['Rear leaf spring broken', 'Leaf spring center bolt sheared'],
    reports: [
      'Truck leans to the right when loaded, loud clunk over bumps.',
      'Rear end sits lower on one side after the Pulilan delivery.',
    ],
    fixes: [
      'Main leaf broken, replaced the leaf and center bolt, new U-bolts.',
      'Center bolt sheared, replaced and torqued the U-bolts.',
    ],
    parts: [
      { name: 'Leaf spring main leaf', price: [2800, 4500] },
      { name: 'Leaf spring center bolt', price: [150, 300] },
      { name: 'U-bolt', price: [350, 600], qty: [2, 4] },
    ],
    entry: {
      name: 'Broken leaf spring or center bolt',
      status: 'ACTIVE',
      symptoms:
        'Truck leans or sits low on one side, clunking over bumps, axle shifted.',
      estimatedHours: 3,
      safetyNotes:
        'Unload the truck first. Support the frame on stands before loosening the U-bolts, the spring holds load.',
      steps: [
        'Unload the truck and support the frame on stands.',
        'Inspect each leaf, the center bolt and the U-bolts.',
        'Remove the spring pack and replace the broken leaf or center bolt.',
        'Fit new U-bolts and torque them to spec.',
        'Lower the truck, check ride height on both sides, re torque after the first loaded trip.',
      ],
      parts: ['Leaf spring main leaf', 'Leaf spring center bolt', 'U-bolt'],
      writtenMonthsAgo: 8,
    },
  },
  {
    key: 'shocks',
    category: 'Suspension',
    priority: 'MEDIUM',
    weight: 4,
    laborHours: [1, 2],
    rootCauses: ['Rear shock absorbers leaking', 'Shock absorbers worn out'],
    reports: [
      'Truck bounces a lot after speed bumps, cargo shifts.',
      'Oil on the body of the rear right shock absorber.',
    ],
    fixes: [
      'Replaced both rear shock absorbers.',
      'Rear shocks leaking, replaced as a pair with new bushings.',
    ],
    parts: [
      { name: 'Shock absorber', price: [1800, 3200], qty: [2, 2] },
      {
        name: 'Shock absorber bushing',
        price: [120, 250],
        qty: [2, 4],
        p: 0.5,
      },
    ],
    entry: {
      name: 'Worn or leaking shock absorbers',
      status: 'ACTIVE',
      symptoms:
        'Bouncing after bumps, oil on the shock body, uneven tire wear.',
      estimatedHours: 1.5,
      steps: [
        'Bounce test each corner and look for oil on the shock bodies.',
        'Replace shocks in pairs on the same axle.',
        'Fit new bushings and torque the mounts with the truck on its wheels.',
      ],
      parts: ['Shock absorber', 'Shock absorber bushing'],
      writtenMonthsAgo: 4,
    },
  },
  {
    key: 'tie-rod',
    category: 'Suspension',
    priority: 'HIGH',
    weight: 3,
    laborHours: [1.5, 2.5],
    rootCauses: ['Tie rod ends worn', 'Steering play from worn tie rod ends'],
    reports: [
      'Steering feels loose, truck wanders on the expressway.',
      'Knocking from the front when turning, front tires wearing on the edges.',
    ],
    fixes: [
      'Both outer tie rod ends worn, replaced and aligned.',
      'Replaced tie rod ends, wheel alignment done.',
    ],
    parts: [
      { name: 'Tie rod end', price: [900, 1600], qty: [1, 2] },
      { name: 'Wheel alignment', price: [800, 1200] },
    ],
    entry: {
      name: 'Worn tie rod ends',
      status: 'ACTIVE',
      symptoms:
        'Loose steering, wandering at speed, knocking when turning, uneven front tire wear.',
      estimatedHours: 2,
      safetyNotes:
        'Always align after replacing tie rod ends before the truck goes back on the road.',
      steps: [
        'Lift the front and check for play at each tie rod end.',
        'Count the threads before removing so the new end goes on close to the old setting.',
        'Replace the worn ends, fit new cotter pins.',
        'Do a wheel alignment and road test.',
      ],
      parts: ['Tie rod end'],
      writtenMonthsAgo: 3,
    },
  },

  // ── Cooling ───────────────────────────────────────────────────────────────
  {
    key: 'radiator-hose',
    category: 'Cooling',
    priority: 'CRITICAL',
    weight: 5,
    laborHours: [1, 2],
    rootCauses: [
      'Radiator hose leaking',
      'Lower radiator hose cracked',
      'Coolant leak at a hose clamp',
    ],
    reports: [
      'Temperature gauge going to red in traffic on C5, steam from the hood.',
      'Coolant puddle under the front of the truck, engine running hot.',
      'Overheated on the NLEX, driver pulled over and called the garage.',
    ],
    fixes: [
      'Lower radiator hose cracked, replaced hose and clamps, refilled coolant.',
      'Replaced both radiator hoses and the thermostat, no more overheating.',
      'Loose clamp on the upper hose, replaced clamp and topped up coolant.',
    ],
    parts: [
      { name: 'Radiator hose', price: [650, 1250], qty: [1, 2] },
      { name: 'Hose clamp', price: [60, 120], qty: [2, 4] },
      { name: 'Coolant 1 gallon', price: [650, 950], qty: [1, 2] },
      { name: 'Thermostat', price: [650, 1100], p: 0.3 },
    ],
    entry: {
      name: 'Radiator hose leak, overheating',
      status: 'ACTIVE',
      symptoms:
        'Temperature gauge rising, steam from the hood, coolant puddle at the front, sweet smell.',
      descriptionTemplate:
        'Engine overheating. Where it happened, how high the gauge went, and whether coolant was leaking.',
      estimatedHours: 1.5,
      safetyNotes:
        'Never open the radiator cap on a hot engine. Wait until it is cool to the touch.',
      steps: [
        'Let the engine cool fully before opening anything.',
        'Pressure test the cooling system to find the leak.',
        'Replace the leaking hose and its clamps.',
        'Refill with coolant and bleed air from the system.',
        'Run to operating temperature with the cap on and check for leaks and fan operation.',
      ],
      parts: ['Radiator hose', 'Hose clamp', 'Coolant 1 gallon'],
      writtenMonthsAgo: 13,
    },
  },
  {
    key: 'water-pump',
    category: 'Cooling',
    priority: 'HIGH',
    weight: 3,
    laborHours: [2.5, 4.5],
    rootCauses: ['Water pump seal leaking', 'Water pump bearing worn'],
    reports: [
      'Coolant dripping from behind the fan, level drops every day.',
      'Whining noise from the front of the engine that rises with rpm.',
    ],
    fixes: [
      'Water pump weep hole leaking, replaced pump and gasket, new coolant.',
      'Water pump bearing worn, replaced pump and drive belt.',
    ],
    parts: [
      { name: 'Water pump', price: [3200, 5500] },
      { name: 'Water pump gasket', price: [180, 300] },
      { name: 'Coolant 1 gallon', price: [650, 950], qty: [1, 2] },
      { name: 'Fan belt', price: [550, 1000], p: 0.4 },
    ],
    entry: {
      name: 'Water pump seal or bearing failure',
      status: 'ACTIVE',
      symptoms:
        'Coolant drip from the weep hole behind the fan, whining from the front of the engine, play in the fan.',
      estimatedHours: 3.5,
      safetyNotes:
        'Work on a cool engine only, and catch the coolant, it is poisonous to animals.',
      steps: [
        'Drain the coolant into a container.',
        'Remove the fan, belt and pulley, then the water pump.',
        'Clean the mating surface and fit the new pump with a new gasket.',
        'Refit the belt and set its tension.',
        'Refill, bleed the air and run to temperature to check for leaks.',
      ],
      parts: ['Water pump', 'Water pump gasket', 'Coolant 1 gallon'],
      writtenMonthsAgo: 9,
    },
  },
  {
    key: 'radiator-clog',
    category: 'Cooling',
    priority: 'HIGH',
    weight: 2,
    laborHours: [2, 4],
    rootCauses: ['Radiator core clogged', 'Radiator fins blocked'],
    reports: [
      'Runs hot on long uphill runs even with full coolant.',
      'Temperature creeps up in traffic, no leaks found.',
    ],
    fixes: [
      'Radiator rodded and flushed at the radiator shop, new cap.',
      'Radiator core cleaned, temperature normal on the road test.',
    ],
    parts: [
      { name: 'Radiator rodding and flushing', price: [1800, 3000] },
      { name: 'Radiator cap', price: [250, 450], p: 0.5 },
      { name: 'Coolant 1 gallon', price: [650, 950], qty: [1, 2] },
    ],
    entry: {
      name: 'Clogged radiator core',
      status: 'ACTIVE',
      symptoms:
        'Runs hot under load or in traffic with full coolant and no leaks.',
      estimatedHours: 3,
      steps: [
        'Rule out the thermostat, fan clutch and leaks first.',
        'Check for cold spots on the radiator core with the engine warm.',
        'Remove the radiator and send it for rodding and flushing.',
        'Refit with a new cap, refill and bleed the system.',
      ],
      parts: ['Radiator cap', 'Coolant 1 gallon'],
      writtenMonthsAgo: 5,
    },
  },

  // ── Transmission ──────────────────────────────────────────────────────────
  {
    key: 'clutch-disc',
    category: 'Transmission',
    priority: 'HIGH',
    weight: 4,
    laborHours: [5, 8],
    rootCauses: ['Clutch disc worn', 'Clutch slipping'],
    reports: [
      'Engine revs climb but the truck does not speed up going uphill.',
      'Burning smell after climbing the Sta. Rosa exit with a full load.',
      'Clutch engages very high on the pedal and slips in third gear.',
    ],
    fixes: [
      'Clutch disc worn to the rivets, replaced disc, pressure plate and release bearing.',
      'Replaced the clutch kit, flywheel resurfaced.',
    ],
    parts: [
      { name: 'Clutch disc', price: [3500, 6500] },
      { name: 'Clutch pressure plate', price: [4500, 7800] },
      { name: 'Release bearing', price: [1200, 2200] },
      { name: 'Pilot bearing', price: [350, 600], p: 0.6 },
      { name: 'Flywheel resurfacing', price: [1200, 1800], p: 0.4 },
    ],
    entry: {
      name: 'Worn clutch disc, slipping',
      status: 'ACTIVE',
      symptoms:
        'Engine revs rise without the truck speeding up, burning smell, clutch engages high on the pedal.',
      estimatedHours: 6,
      safetyNotes:
        'The transmission is heavy. Use a transmission jack and a second person to remove and refit it.',
      steps: [
        'Confirm the slip with a stall test in a high gear.',
        'Support the engine and remove the propeller shaft and transmission.',
        'Inspect the disc, pressure plate, flywheel and release bearing.',
        'Fit the new clutch kit and pilot bearing, align the disc with the tool.',
        'Refit the transmission, adjust the clutch pedal free play and road test.',
      ],
      parts: [
        'Clutch disc',
        'Clutch pressure plate',
        'Release bearing',
        'Pilot bearing',
      ],
      writtenMonthsAgo: 11,
    },
  },
  {
    key: 'clutch-hydraulic',
    category: 'Transmission',
    priority: 'HIGH',
    weight: 3,
    laborHours: [1.5, 3],
    rootCauses: [
      'Clutch slave cylinder leaking',
      'Clutch master cylinder seal worn',
    ],
    reports: [
      'Clutch pedal stays near the floor and gears grind.',
      'Hard to shift into gear, clutch fluid reservoir almost empty.',
    ],
    fixes: [
      'Slave cylinder leaking, replaced and bled the clutch.',
      'Replaced the clutch master cylinder and bled the line.',
    ],
    parts: [
      { name: 'Clutch slave cylinder', price: [1800, 2900], p: 0.6 },
      { name: 'Clutch master cylinder', price: [2200, 3400], p: 0.5 },
      { name: 'Brake fluid DOT3 1L', price: [380, 480] },
    ],
    entry: {
      name: 'Clutch master or slave cylinder leak',
      status: 'ACTIVE',
      symptoms:
        'Clutch pedal sinks or stays down, gears grind when shifting, fluid low in the clutch reservoir.',
      estimatedHours: 2,
      steps: [
        'Check the clutch reservoir level and look for leaks at both cylinders.',
        'Replace the leaking cylinder.',
        'Bleed the clutch line until the pedal is firm.',
        'Check pedal free play and shift through every gear.',
      ],
      parts: [
        'Clutch slave cylinder',
        'Clutch master cylinder',
        'Brake fluid DOT3',
      ],
      writtenMonthsAgo: 6,
    },
  },
  {
    key: 'gearbox-seal',
    category: 'Transmission',
    priority: 'MEDIUM',
    weight: 2,
    laborHours: [2, 3.5],
    rootCauses: ['Transmission rear oil seal leaking'],
    reports: [
      'Gear oil dripping where the propeller shaft meets the transmission.',
      'Oil spots under the middle of the truck after parking.',
    ],
    fixes: ['Replaced the transmission rear oil seal and refilled gear oil.'],
    parts: [
      { name: 'Transmission rear oil seal', price: [450, 800] },
      { name: 'Gear oil 75W-90 1L', price: [420, 560], qty: [2, 4] },
    ],
    entry: {
      name: 'Transmission rear oil seal leak',
      status: 'ACTIVE',
      symptoms:
        'Gear oil drips at the back of the transmission, oil spots under the middle of the truck.',
      estimatedHours: 2.5,
      steps: [
        'Clean the area and confirm the leak is at the rear seal.',
        'Mark and remove the propeller shaft.',
        'Pull the old seal and drive in the new one evenly.',
        'Refit the shaft to its marks and top up the gear oil to the fill plug.',
      ],
      parts: ['Transmission rear oil seal', 'Gear oil 75W-90'],
      writtenMonthsAgo: 4,
    },
  },

  // ── General ───────────────────────────────────────────────────────────────
  {
    key: 'tire',
    category: 'General',
    priority: 'MEDIUM',
    weight: 6,
    laborHours: [0.5, 1.25],
    rootCauses: [
      'Rear tire worn past the limit',
      'Tire sidewall cut',
      'Slow leak at the tire valve',
    ],
    reports: [
      'Rear inner tire keeps losing pressure.',
      'Driver found a cut on the sidewall of the front left tire.',
      'Tread worn down on both rear outer tires.',
    ],
    fixes: [
      'Replaced the tire, balanced and set pressure.',
      'Valve leaking, replaced valve and patched the tire.',
      'Two rear tires replaced, rotated the rest.',
    ],
    parts: [
      { name: 'Tire 7.00-16', price: [6500, 8800], qty: [1, 2], p: 0.75 },
      { name: 'Tire vulcanizing', price: [150, 300], p: 0.25 },
      { name: 'Tire valve', price: [50, 100], p: 0.4 },
    ],
    entry: {
      name: 'Tire worn, cut or leaking',
      status: 'ACTIVE',
      symptoms:
        'Low pressure, visible cuts or bulges, tread worn to the wear bars.',
      estimatedHours: 0.75,
      steps: [
        'Check all tire pressures and tread depth.',
        'Inspect the leaking or damaged tire inside and out.',
        'Patch, replace the valve, or replace the tire.',
        'Torque the wheel nuts and set the pressure to spec.',
      ],
      parts: ['Tire 7.00-16', 'Tire valve'],
      writtenMonthsAgo: 10,
    },
  },
  {
    key: 'aircon',
    category: 'Electrical',
    priority: 'MEDIUM',
    weight: 14,
    laborHours: [1, 2.5],
    recentDays: 75,
    rootCauses: ['Aircon not cooling'],
    reports: [
      'Aircon not cooling, blows warm air.',
      'Aircon not cooling, warm air on high.',
      'Aircon not cooling in the afternoon.',
      'Aircon not cooling, compressor not engaging.',
    ],
    fixes: [
      'Aircon not cooling, replaced clutch coil.',
      'Aircon not cooling, recharged freon.',
      'Aircon not cooling, replaced relay.',
    ],
    parts: [
      { name: 'Aircon compressor clutch coil', price: [3500, 5500], p: 0.5 },
      { name: 'Freon R134a recharge', price: [1200, 1800] },
      { name: 'Aircon relay', price: [250, 450], p: 0.4 },
    ],
    entry: {
      name: 'Aircon compressor clutch not engaging',
      status: 'DRAFT',
      symptoms: 'Aircon blows warm air, compressor clutch does not click in.',
      estimatedHours: 1.5,
      steps: [
        'Check the aircon fuse and relay.',
        'Check voltage at the compressor clutch connector with the aircon on.',
        'Measure the clutch coil resistance.',
      ],
      parts: ['Aircon compressor clutch coil', 'Aircon relay'],
      writtenMonthsAgo: 0.3,
    },
  },
  {
    key: 'cargo-door',
    category: 'General',
    priority: 'MEDIUM',
    weight: 9,
    laborHours: [0.75, 2],
    recentDays: 90,
    rootCauses: ['Rear cargo door latch broken'],
    reports: [
      'Rear cargo door latch broken, door will not lock.',
      'Rear cargo door latch broken, door swings open.',
      'Rear cargo door latch broken, handle turns freely.',
    ],
    fixes: [
      'Rear cargo door latch broken, replaced latch.',
      'Rear cargo door latch broken, welded latch bracket.',
    ],
    parts: [
      { name: 'Cargo door latch assembly', price: [1500, 2800] },
      { name: 'Lock rod', price: [450, 850], p: 0.4 },
      { name: 'Welding service', price: [500, 900], p: 0.3 },
    ],
  },
  {
    key: 'horn',
    category: 'Electrical',
    priority: 'LOW',
    weight: 5,
    laborHours: [0.25, 1],
    recentDays: 120,
    rootCauses: ['Horn not working'],
    reports: [
      'Horn not working when pressed.',
      'Horn not working, only sounds sometimes.',
      'Horn not working after the truck was washed.',
    ],
    fixes: [
      'Horn not working, replaced horn relay.',
      'Horn not working, cleaned corroded horn connector.',
    ],
    parts: [
      { name: 'Horn relay', price: [250, 450], p: 0.6 },
      { name: 'Horn 24V', price: [450, 900], p: 0.4 },
    ],
  },
];

// One off body and cab problems: each has its own wording, so they never look like a recurring group
const ONE_OFFS: [string, string, string, string, [number, number]][] = [
  [
    'Side mirror bracket cracked',
    'Right side mirror shakes at speed, bracket has a crack near the door hinge.',
    'Welded the bracket and refitted the mirror.',
    'Side mirror bracket',
    [450, 900],
  ],
  [
    'Seat belt buckle stuck',
    'Driver seat belt will not release from the buckle.',
    'Replaced the buckle assembly.',
    'Seat belt buckle',
    [650, 1200],
  ],
  [
    'Cab door weather strip torn',
    'Rain leaks into the cab through the left door seal.',
    'Replaced the door weather strip.',
    'Door weather strip',
    [700, 1300],
  ],
  [
    'Fuel tank strap loose',
    'Knocking under the cab on rough roads, the fuel tank moves.',
    'Retightened the tank straps and added rubber pads.',
    'Tank strap rubber pad',
    [250, 500],
  ],
  [
    'Mud flap torn off',
    'Rear left mud flap missing after the Pulilan provincial road.',
    'Fitted a new mud flap and bracket.',
    'Mud flap with bracket',
    [550, 950],
  ],
  [
    'Wiper blades worn',
    'Wipers leave streaks and skip across the windshield.',
    'Replaced both wiper blades.',
    'Wiper blade pair',
    [450, 800],
  ],
  [
    'Driver seat adjuster broken',
    'Driver seat slides forward when braking, lever does not lock.',
    'Replaced the seat slide lock spring.',
    'Seat slide lock spring',
    [300, 600],
  ],
];

PROBLEMS.push(
  ...ONE_OFFS.map(
    ([rootCause, report, fix, part, price], i): Problem => ({
      key: `one-off-${i}`,
      category: 'General',
      priority: 'LOW',
      weight: 0.2,
      laborHours: [0.5, 1.5],
      rootCauses: [rootCause],
      reports: [report],
      fixes: [fix],
      parts: [{ name: part, price }],
    }),
  ),
);

// ── Fleet and people ─────────────────────────────────────────────────────────

export type VehicleSpec = {
  plateNumber: string;
  model: string;
  /** A starting vehicle type name from the lookup list (spec 0016, AC-21). */
  type: string;
  /** Payload in kilograms. */
  capacity: number;
  /** Odometer at the start of the seeded history. */
  startKm: number;
  /** Average kilometers a working day. */
  kmPerDay: number;
  garage: string;
  /** Sold or retired: months ago it left the fleet. */
  retiredMonthsAgo?: number;
};

export const VEHICLES: VehicleSpec[] = [
  {
    plateNumber: 'NDG 5821',
    model: 'Isuzu Elf NKR',
    type: '4 wheeler',
    capacity: 3000,
    startKm: 41200,
    kmPerDay: 140,
    garage: 'Sta. Rosa',
  },
  {
    plateNumber: 'NEB 7306',
    model: 'Isuzu Elf NLR',
    type: '4 wheeler',
    capacity: 3500,
    startKm: 18600,
    kmPerDay: 160,
    garage: 'Sta. Rosa',
  },
  {
    plateNumber: 'DAK 2917',
    model: 'Isuzu Elf NPR',
    type: '6 wheeler',
    capacity: 4000,
    startKm: 96300,
    kmPerDay: 120,
    garage: 'Sta. Rosa',
  },
  {
    plateNumber: 'NIE 4482',
    model: 'Mitsubishi Fuso Canter FE71',
    type: '6 wheeler',
    capacity: 3500,
    startKm: 63800,
    kmPerDay: 150,
    garage: 'Sta. Rosa',
  },
  {
    plateNumber: 'CAK 9043',
    model: 'Hino 300 Dutro',
    type: '6 wheeler',
    capacity: 4000,
    startKm: 72000,
    kmPerDay: 130,
    garage: 'Sta. Rosa',
  },
  {
    plateNumber: 'NBQ 1175',
    model: 'Toyota Hiace Commuter',
    type: '4 wheeler',
    capacity: 1200,
    startKm: 28400,
    kmPerDay: 180,
    garage: 'Sta. Rosa',
  },
  {
    plateNumber: 'PXW 382',
    model: 'Mitsubishi L300 FB',
    type: '4 wheeler',
    capacity: 1000,
    startKm: 154200,
    kmPerDay: 110,
    garage: 'Sta. Rosa',
    retiredMonthsAgo: 7,
  },
  {
    plateNumber: 'NAU 6620',
    model: 'Isuzu Forward FRR',
    type: '10 wheeler',
    capacity: 7000,
    startKm: 88100,
    kmPerDay: 170,
    garage: 'Sta. Rosa',
  },

  {
    plateNumber: 'NCX 3359',
    model: 'Isuzu Elf NKR',
    type: '4 wheeler',
    capacity: 3000,
    startKm: 52700,
    kmPerDay: 110,
    garage: 'Marikina',
  },
  {
    plateNumber: 'WOB 2947',
    model: 'Hino 300 Dutro',
    type: '6 wheeler',
    capacity: 4000,
    startKm: 31500,
    kmPerDay: 125,
    garage: 'Marikina',
  },
  {
    plateNumber: 'NFH 8814',
    model: 'Mitsubishi Fuso Canter FE71',
    type: '6 wheeler',
    capacity: 3500,
    startKm: 44900,
    kmPerDay: 115,
    garage: 'Marikina',
  },
  {
    plateNumber: 'DCR 5096',
    model: 'Isuzu Elf NLR',
    type: '4 wheeler',
    capacity: 3500,
    startKm: 109400,
    kmPerDay: 100,
    garage: 'Marikina',
  },
  {
    plateNumber: 'NGT 2731',
    model: 'Hyundai H100',
    type: '4 wheeler',
    capacity: 1000,
    startKm: 36800,
    kmPerDay: 150,
    garage: 'Marikina',
  },
  {
    plateNumber: 'NJA 9468',
    model: 'Toyota Hiace Commuter',
    type: '4 wheeler',
    capacity: 1200,
    startKm: 12300,
    kmPerDay: 165,
    garage: 'Marikina',
  },
  {
    plateNumber: 'NKP 4027',
    model: 'Isuzu Forward FRR',
    type: '10 wheeler',
    capacity: 7000,
    startKm: 67500,
    kmPerDay: 155,
    garage: 'Marikina',
  },

  {
    plateNumber: 'TGD 908',
    model: 'Foton Tornado',
    type: '6 wheeler',
    capacity: 5000,
    startKm: 92000,
    kmPerDay: 135,
    garage: 'Pulilan',
  },
  {
    plateNumber: 'NRE 471',
    model: 'Isuzu Giga FVR',
    type: 'Tractor head',
    capacity: 9000,
    startKm: 145000,
    kmPerDay: 190,
    garage: 'Pulilan',
  },
  {
    plateNumber: 'NMS 3384',
    model: 'Isuzu Elf NPR',
    type: '6 wheeler',
    capacity: 4000,
    startKm: 58200,
    kmPerDay: 145,
    garage: 'Pulilan',
  },
  {
    plateNumber: 'NOV 1652',
    model: 'Hino 500 FC',
    type: '10 wheeler',
    capacity: 6500,
    startKm: 81600,
    kmPerDay: 175,
    garage: 'Pulilan',
  },
  {
    plateNumber: 'DFL 7790',
    model: 'Mitsubishi Fuso Canter FE85',
    type: '6 wheeler',
    capacity: 4500,
    startKm: 101700,
    kmPerDay: 140,
    garage: 'Pulilan',
  },
  {
    plateNumber: 'NPW 5213',
    model: 'Isuzu Elf NKR',
    type: '4 wheeler',
    capacity: 3000,
    startKm: 22900,
    kmPerDay: 150,
    garage: 'Pulilan',
  },
  {
    plateNumber: 'NQZ 8045',
    model: 'Hino 300 Dutro',
    type: '6 wheeler',
    capacity: 4000,
    startKm: 47300,
    kmPerDay: 130,
    garage: 'Pulilan',
  },
];

export type DriverSpec = {
  name: string;
  licenseNumber: string;
  isVerified: boolean;
  garage: string;
  /** Left the company: months ago. */
  leftMonthsAgo?: number;
};

export const DRIVERS: DriverSpec[] = [
  {
    name: 'Danilo Ramos',
    licenseNumber: 'N01-12-894721',
    isVerified: true,
    garage: 'Sta. Rosa',
  },
  {
    name: 'Edgardo Santos',
    licenseNumber: 'D18-09-247913',
    isVerified: false,
    garage: 'Sta. Rosa',
  },
  {
    name: 'Arnel Gonzales',
    licenseNumber: 'D02-14-572948',
    isVerified: true,
    garage: 'Sta. Rosa',
  },
  {
    name: 'Jonathan Macaraeg',
    licenseNumber: 'N25-16-308114',
    isVerified: true,
    garage: 'Sta. Rosa',
  },
  {
    name: 'Melchor Ilagan',
    licenseNumber: 'D04-11-662039',
    isVerified: true,
    garage: 'Sta. Rosa',
  },
  {
    name: 'Ronaldo Pineda',
    licenseNumber: 'N04-19-115780',
    isVerified: true,
    garage: 'Sta. Rosa',
    leftMonthsAgo: 9,
  },
  {
    name: 'Mark Anthony Lim',
    licenseNumber: 'N25-21-490366',
    isVerified: false,
    garage: 'Sta. Rosa',
  },

  {
    name: 'Ramon dela Cruz',
    licenseNumber: 'N22-15-683921',
    isVerified: true,
    garage: 'Marikina',
  },
  {
    name: 'Bernardo Reyes',
    licenseNumber: 'N15-18-934721',
    isVerified: true,
    garage: 'Marikina',
  },
  {
    name: 'Jericho Navarro',
    licenseNumber: 'N10-17-275503',
    isVerified: true,
    garage: 'Marikina',
  },
  {
    name: 'Alvin Sarmiento',
    licenseNumber: 'D13-13-804216',
    isVerified: true,
    garage: 'Marikina',
  },
  {
    name: 'Rhea Manalastas',
    licenseNumber: 'N12-20-157842',
    isVerified: true,
    garage: 'Marikina',
  },
  {
    name: 'Joel Fajardo',
    licenseNumber: 'N06-22-930475',
    isVerified: false,
    garage: 'Marikina',
  },

  {
    name: 'Catalino Castro',
    licenseNumber: 'D04-20-472198',
    isVerified: false,
    garage: 'Pulilan',
  },
  {
    name: 'Dionisio Bulaon',
    licenseNumber: 'N08-11-237498',
    isVerified: true,
    garage: 'Pulilan',
  },
  {
    name: 'Noel Pangilinan',
    licenseNumber: 'N03-14-561207',
    isVerified: true,
    garage: 'Pulilan',
  },
  {
    name: 'Efren Dimaculangan',
    licenseNumber: 'D03-10-728834',
    isVerified: true,
    garage: 'Pulilan',
  },
  {
    name: 'Rogelio Manansala',
    licenseNumber: 'N03-18-046629',
    isVerified: true,
    garage: 'Pulilan',
  },
  {
    name: 'Kristine Soriano',
    licenseNumber: 'N03-23-319958',
    isVerified: true,
    garage: 'Pulilan',
  },
];

// ── Ticket notes ─────────────────────────────────────────────────────────────

export const CANCEL_REASONS = [
  'Duplicate ticket, the same problem was already logged for this truck.',
  'Vehicle sent to the dealer instead, the repair is covered by warranty.',
  'Driver report could not be reproduced on the road test, no fault found.',
  'Client cancelled the trip, the truck was moved to the other garage for repair.',
  'Logged on the wrong plate number, re-entered under the correct truck.',
  'Problem was fixed on the road by the driver, nothing left to repair.',
];

export const REMARKS = [
  'Recommend replacing the rear brake shoes at the next PMS, about 40% left.',
  'Front tires are due for rotation.',
  'Fan belt shows cracks, replace at the next visit.',
  'Driver advised to check coolant level every morning this week.',
  'Battery terminals were corroded, cleaned and greased.',
  'Engine oil change is due in about 1,000 km.',
  'Road tested 10 km with a load, no issues.',
  'Waited two days for parts from the Banawe supplier.',
];

export const UNLOCK_REASONS = [
  'Supplier sent the final invoice, the parts cost was higher than the quote.',
  'Labor cost was encoded twice, correcting the amount.',
  'Outside shop added a charge for the road test, updating the bill.',
];

export const CHANGE_SUGGESTIONS: { entry: string; body: string }[] = [
  {
    entry: 'Brake pads worn',
    body: 'Add a step to check the caliper slide pins for rust. Two Elf units this month had seized pins that wore the inner pad first.',
  },
  {
    entry: 'Radiator hose leak, overheating',
    body: 'The Forward trucks use a different lower hose. Please list both part numbers so we order the right one.',
  },
  {
    entry: 'Weak or dead battery',
    body: 'Most failures this year were batteries over 2 years old. Maybe add the battery age check to the first step.',
  },
  {
    entry: 'Clogged fuel filter or water in fuel',
    body: 'The estimate is too low for the Giga, bleeding the system takes longer. Closer to 1.5 hours.',
  },
];

export const NEW_ENTRY_SUGGESTIONS = [
  'Rear cargo door latches keep breaking on the wing vans. Can we add an entry with the striker adjustment?',
  'Aircon not cooling keeps coming back on the Hiace units. We should have a common issue for it.',
];

export const DECLINED_SUGGESTIONS = [
  {
    entry: 'Tire worn, cut or leaking',
    body: 'Add the brand of tire we should buy.',
    status: 'DISMISSED' as const,
  },
  {
    entry: 'Worn tie rod ends',
    body: 'Add the step to count threads before removing the old end.',
    status: 'ACCEPTED' as const,
  },
];
