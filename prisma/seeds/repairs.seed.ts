import {
  Driver,
  Prisma,
  PrismaClient,
  RepairPriority,
  RepairStatus,
  Vehicle,
  VehicleStatus,
} from '@prisma/client';
import {
  CANCEL_REASONS,
  CHANGE_SUGGESTIONS,
  DRIVERS,
  NEW_ENTRY_SUGGESTIONS,
  PROBLEMS,
  Problem,
  REMARKS,
  UNLOCK_REASONS,
  VEHICLES,
} from './catalog';
import { SeededEntry } from './knowledge.seed';
import { seedActor, VRMS_ADMIN } from './shared-ids';
import {
  AuditEventData,
  costEvent,
  createdEvent,
  garageEvent,
  knowledgeLinkEvent,
  statusEvent,
  unlockEvent,
} from '../../src/modules/vrms/audit-events';
import {
  DAY,
  HOUR,
  addWorkHours,
  around,
  between,
  chance,
  duringShopHours,
  int,
  manilaDateKey,
  peso,
  pick,
  quarter,
  random,
  shuffle,
  uuid,
  weighted,
} from './random';

// Plays out each truck's repair history in order, so tickets never overlap on one truck, odometers
// only go up, and a ticket's status is wherever its own timeline has reached today. Every change
// writes the audit row the API would write (spec 0010 shape), with the welinc-auth id, name and
// role from shared-ids.ts. Due dates stay empty: feature 42 is their first writer.

const HISTORY_MONTHS = 22;
const ADMIN = VRMS_ADMIN.email;
const PRIORITY_RANK: Record<RepairPriority, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

// Home garage of the mechanics who have a demo login; the rest are spread round robin
const HOME_GARAGE: Record<string, string> = {
  'mech.juan@welinc.com': 'Sta. Rosa',
  'mech.pedro@welinc.com': 'Sta. Rosa',
  'vrms.chief@welinc.com': 'Sta. Rosa',
  'mech.rommel@welinc.com': 'Marikina',
  'mech.isabel@welinc.com': 'Pulilan',
  'mech.carl@welinc.com': 'Pulilan',
};

type Crew = {
  id: string;
  name: string;
  email: string | null;
  garage: string;
  demo: boolean;
  busyUntil: number;
  hasOpen: boolean;
};

type Rows = {
  tickets: Prisma.RepairTicketCreateManyInput[];
  issues: Prisma.RepairIssueCreateManyInput[];
  steps: Prisma.RepairIssueStepCreateManyInput[];
  parts: Prisma.RepairPartCreateManyInput[];
  audits: Prisma.AuditLogCreateManyInput[];
  assignments: Prisma.TicketAssignmentCreateManyInput[];
};

type IssueMeta = {
  id: string;
  ticketId: string;
  problem: Problem;
  entryId: string | null;
  createdAt: number;
  closed: boolean;
  cancelled: boolean;
};

export async function seedRepairs(
  prisma: PrismaClient,
  ctx: {
    now: number;
    vehicles: Vehicle[];
    drivers: Driver[];
    entries: Map<string, SeededEntry>;
    categoryId: Map<string, string>;
  },
) {
  const { now, entries, categoryId } = ctx;
  console.log(`Simulating ${HISTORY_MONTHS} months of repair history...`);

  const garages = new Map(
    (await prisma.garage.findMany()).map((g) => [g.name, g]),
  );

  // ── Crews ────────────────────────────────────────────────────────────────
  const inHouse = await prisma.mechanic.findMany({ orderBy: { name: 'asc' } });
  const garageNames = [...garages.keys()];
  let roundRobin = 0;
  const crews: Crew[] = inHouse.map((m) => {
    const email = m.email;
    const home = email ? HOME_GARAGE[email] : undefined;
    return {
      id: m.id,
      name: m.name,
      email,
      garage: home ?? garageNames[roundRobin++ % garageNames.length],
      demo: !!home,
      busyUntil: 0,
      hasOpen: false,
    };
  });

  // Each truck has a regular driver from its garage
  const driverByName = new Map(ctx.drivers.map((d) => [d.name, d]));
  const driversAt = (garage: string, at: number) =>
    DRIVERS.filter(
      (d) =>
        d.garage === garage &&
        (!d.leftMonthsAgo || at < now - d.leftMonthsAgo * 30 * DAY),
    ).map((d) => driverByName.get(d.name)!);

  const rows: Rows = {
    tickets: [],
    issues: [],
    steps: [],
    parts: [],
    audits: [],
    assignments: [],
  };
  const issueMeta: IssueMeta[] = [];
  const repairNumbers = new Set<string>();
  const vehicleUpdates: {
    id: string;
    odometer: number;
    status: VehicleStatus;
    retiredAt: number | null;
  }[] = [];
  const counts = Object.fromEntries(
    Object.values(RepairStatus).map((s) => [s, 0]),
  ) as Record<RepairStatus, number>;

  const audit = (
    ticketId: string,
    at: number,
    email: string,
    event: AuditEventData,
  ) =>
    rows.audits.push({
      id: uuid(),
      repairTicketId: ticketId,
      ...seedActor(email),
      action: event.action,
      changes: event.changes,
      note: event.note,
      createdAt: new Date(at),
    });

  const historyStart = now - HISTORY_MONTHS * 30 * DAY;

  for (const vehicle of ctx.vehicles) {
    const spec = VEHICLES.find((v) => v.plateNumber === vehicle.plateNumber)!;
    const retiredAt = spec.retiredMonthsAgo
      ? now - spec.retiredMonthsAgo * 30 * DAY
      : null;
    const end = retiredAt ? retiredAt - 20 * DAY : now;
    // Older, high mileage trucks come in more often
    const wear = spec.startKm > 90_000 ? 0.75 : spec.startKm < 30_000 ? 1.3 : 1;
    const regular = pick(driversAt(spec.garage, historyStart));

    let t = historyStart + between(0, 25) * DAY;
    let km = spec.startKm;
    let lastClosedKm = spec.startKm;
    let open = false;
    let freeSince = t; // when the truck last left the shop

    for (;;) {
      const gapDays = around(8, 55) * wear;
      t += gapDays * DAY;
      if (t >= end) break;
      km += Math.round(spec.kmPerDay * gapDays * (6 / 7) * between(0.85, 1.15));

      const result = buildTicket({
        vehicle,
        spec,
        createdAt: duringShopHours(t),
        km,
        regular,
      });
      if (!result) continue;
      if (result.status === RepairStatus.CLOSED) lastClosedKm = km;
      if (!result.closedAt) {
        open = true;
        break;
      }
      t = result.closedAt;
      freeSince = t;
    }

    // About a third of the working fleet is in the shop today, so the open queue looks like a real day
    if (!open && !retiredAt && chance(0.35)) {
      const createdAt = duringShopHours(
        Math.max(freeSince + DAY, now - between(0.05, 2) * DAY),
      );
      if (createdAt > freeSince && createdAt < now - HOUR) {
        km += Math.max(
          0,
          Math.round(
            spec.kmPerDay * ((createdAt - freeSince) / DAY) * (6 / 7) -
              (km - lastClosedKm),
          ),
        );
        const result = buildTicket({ vehicle, spec, createdAt, km, regular });
        if (result?.status === RepairStatus.CLOSED) lastClosedKm = km;
        open = !!result && !result.closedAt;
      }
    }

    vehicleUpdates.push({
      id: vehicle.id,
      odometer: lastClosedKm,
      status: open ? VehicleStatus.UNDER_REPAIR : VehicleStatus.AVAILABLE,
      retiredAt,
    });
  }

  function buildTicket(args: {
    vehicle: Vehicle;
    spec: (typeof VEHICLES)[number];
    createdAt: number;
    km: number;
    regular: Driver;
  }) {
    const { vehicle, spec, createdAt, km } = args;
    const daysAgo = (now - createdAt) / DAY;

    // ── What is wrong ──
    const possible = PROBLEMS.filter(
      (p) =>
        p.weight > 0 &&
        (!p.recentDays || daysAgo <= p.recentDays) &&
        (!p.beforeDaysAgo || daysAgo >= p.beforeDaysAgo),
    );
    const issueCount = weighted([1, 2, 3], (n) =>
      n === 1 ? 78 : n === 2 ? 18 : 4,
    );
    const problems: Problem[] = [];
    while (problems.length < issueCount) {
      const p = weighted(possible, (x) => x.weight);
      if (!problems.includes(p)) problems.push(p);
    }
    const priority = problems.reduce<RepairPriority>(
      (top, p) =>
        PRIORITY_RANK[p.priority] > PRIORITY_RANK[top] ? p.priority : top,
      'LOW',
    );

    // ── Where and who ──
    const garageName = chance(0.9)
      ? spec.garage
      : pick(garageNames.filter((g) => g !== spec.garage));
    const garage = garages.get(garageName)!;
    const pool = driversAt(spec.garage, createdAt);
    const driver =
      pool.includes(args.regular) && chance(0.75) ? args.regular : pick(pool);

    // ── Timeline (computed first, so the status is wherever it has reached today) ──
    const issueHours = problems.map((p) =>
      quarter(around(p.laborHours[0], p.laborHours[1])),
    );
    const crewSize =
      issueHours.reduce((a, b) => a + b, 0) > 4 && chance(0.45)
        ? 2
        : 1;
    const workHours =
      issueHours.reduce((a, b) => a + b, 0) / (crewSize === 2 ? 1.6 : 1);
    // Waits in working hours: for a free bay and mechanic, for parts, for the admin to encode and verify
    const QUEUE: Record<RepairPriority, [number, number]> = {
      CRITICAL: [0.25, 2],
      HIGH: [1, 10],
      MEDIUM: [3, 20],
      LOW: [6, 36],
    };
    const startAt = addWorkHours(
      createdAt,
      between(...QUEUE[priority]),
    );
    const partsWait = chance(0.3) ? between(1, 5) * DAY : 0;
    const fvAt = addWorkHours(startAt + partsWait, workHours);
    const costAt = addWorkHours(fvAt, between(0.5, 8));
    const completeAt = addWorkHours(costAt, between(0.5, 12));

    const cancels = chance(0.05);
    const cancelFromProgress = cancels && chance(0.3);
    const cancelAt = cancels
      ? addWorkHours(cancelFromProgress ? startAt : createdAt, between(0.5, 12))
      : Infinity;

    let status: RepairStatus;
    if (cancels && cancelAt <= now) status = RepairStatus.CANCELLED;
    else if (cancels)
      status =
        cancelFromProgress && now >= startAt
          ? RepairStatus.IN_PROGRESS
          : RepairStatus.ASSIGNED;
    else if (now < startAt) status = RepairStatus.ASSIGNED;
    else if (now < fvAt) status = RepairStatus.IN_PROGRESS;
    else if (now < completeAt) status = RepairStatus.FOR_VERIFICATION;
    else status = RepairStatus.CLOSED;

    const isOpen =
      status !== RepairStatus.CLOSED && status !== RepairStatus.CANCELLED;
    const closedAt =
      status === RepairStatus.CLOSED
        ? completeAt
        : status === RepairStatus.CANCELLED
          ? cancelAt
          : null;
    const reachedProgress =
      status === RepairStatus.CANCELLED
        ? cancelFromProgress
        : status !== RepairStatus.ASSIGNED;
    const reachedVerification =
      status === RepairStatus.FOR_VERIFICATION ||
      status === RepairStatus.CLOSED;
    const costsIn =
      status === RepairStatus.CLOSED ||
      (status === RepairStatus.FOR_VERIFICATION && costAt <= now);

    // ── Crew ──
    const free = crews.filter(
      (c) => c.garage === garageName && c.busyUntil <= createdAt,
    );
    const candidates =
      free.length >= crewSize
        ? free
        : crews.filter((c) => c.garage === garageName);
    // An open ticket goes to a demo login that has none yet, so every demo account has live work
    const demoWanting = isOpen
      ? candidates.filter(
          (c) => c.demo && !c.hasOpen && c.busyUntil <= createdAt,
        )
      : [];
    const lead = demoWanting.length
      ? pick(demoWanting)
      : weighted(candidates, (c) => (c.demo ? 5 : 1));
    const crew: Crew[] = [lead];
    if (crewSize === 2) {
      const second = candidates.filter((c) => c !== lead);
      if (second.length) crew.push(weighted(second, (c) => (c.demo ? 3 : 1)));
    }
    for (const c of crew) {
      c.busyUntil = closedAt ?? Infinity;
      if (isOpen) c.hasOpen = true;
    }
    const worker = crew[0].email ?? ADMIN;

    // ── Ticket ──
    const ticketId = uuid();
    let repairNumber: string;
    do {
      repairNumber = `REP-${manilaDateKey(createdAt)}-${Math.floor(
        random() * 36 ** 4,
      )
        .toString(36)
        .toUpperCase()
        .padStart(4, '0')}`;
    } while (repairNumbers.has(repairNumber));
    repairNumbers.add(repairNumber);

    // Picked up front, because the status change rows carry them as their note
    const cancellationReason =
      status === RepairStatus.CANCELLED ? pick(CANCEL_REASONS) : null;
    const remarks = reachedVerification && chance(0.3) ? pick(REMARKS) : null;

    audit(ticketId, createdAt, ADMIN, createdEvent());
    let lastChange = createdAt;

    // Logged at the wrong garage now and then, moved within the hour
    if (chance(0.02)) {
      const from = pick(garageNames.filter((g) => g !== garageName));
      const at = createdAt + between(10, 50) * 60_000;
      audit(ticketId, at, ADMIN, garageEvent(from, garageName));
      lastChange = at;
    }

    if (reachedProgress) {
      audit(
        ticketId,
        startAt,
        worker,
        statusEvent(RepairStatus.ASSIGNED, RepairStatus.IN_PROGRESS),
      );
      lastChange = startAt;
    }

    // ── Issues ──
    problems.forEach((problem, index) => {
      const issueId = uuid();
      const entry = entries.get(problem.key);
      const pickable = (at: number) =>
        !!entry &&
        entry.activeFrom != null &&
        entry.activeFrom <= at &&
        (entry.inactiveFrom == null || at < entry.inactiveFrom);

      // Linked at create (picked in the form), later by the mechanic, or by an editor's backfill
      let linkAt: number | null = null;
      let linkBy: string | null = null;
      if (entry && pickable(createdAt) && chance(0.94)) {
        linkAt = createdAt;
      } else if (entry && reachedProgress && pickable(startAt) && chance(0.4)) {
        linkAt = startAt + between(5, 40) * 60_000;
        linkBy = worker;
      } else if (
        entry &&
        entry.activeFrom != null &&
        createdAt < entry.activeFrom &&
        status !== RepairStatus.CANCELLED &&
        chance(0.85)
      ) {
        linkAt = entry.activeFrom + index * 1000;
        linkBy = entry.createdByEmail;
      }
      const linked = linkAt != null && linkAt <= now;
      if (linked && linkBy) {
        audit(
          ticketId,
          linkAt!,
          linkBy,
          knowledgeLinkEvent(issueId, null, entry!.name),
        );
        // A mechanic's link touches the ticket; an editor's backfill never does (AC-33)
        if (linkBy === worker) lastChange = Math.max(lastChange, linkAt!);
      }
      // Steps are copied only while the ticket is still open when it gets linked
      const linkedWhileOpen =
        linked &&
        (closedAt == null || linkAt! < closedAt) &&
        linkAt! < (reachedVerification ? fvAt : Infinity);
      const linkedBeforeVerification = linked && linkAt! < fvAt;

      const rootCause = pick(problem.rootCauses);
      const report = pick(problem.reports);
      const hours = issueHours[index];

      if (linkedWhileOpen) {
        const total = entry!.steps.length;
        const followed = chance(0.9);
        const doneCount = reachedVerification
          ? followed
            ? total
            : Math.max(0, total - int(1, 2))
          : status === RepairStatus.IN_PROGRESS
            ? Math.floor(
                total *
                  Math.min(
                    1,
                    Math.max(
                      0,
                      (now - startAt) / Math.max(HOUR, fvAt - startAt),
                    ),
                  ),
              )
            : 0;
        const from = Math.max(startAt, linkAt!);
        const to = reachedVerification ? fvAt : Math.min(now, fvAt);
        entry!.steps.forEach((text, i) => {
          const checked = i < doneCount;
          rows.steps.push({
            id: uuid(),
            repairIssueId: issueId,
            position: i + 1,
            text,
            checkedAt: checked
              ? new Date(
                  from + ((i + 1) / (total + 1)) * Math.max(0, to - from),
                )
              : null,
            checkedByEmail: checked ? worker : null,
          });
        });
      }

      // "What fixed it", written on the move to For verification
      let resolution: Partial<Prisma.RepairIssueCreateManyInput> = {};
      if (reachedVerification) {
        const note = linkedBeforeVerification
          ? chance(0.4)
            ? pick(problem.fixes)
            : null
          : pick(problem.fixes);
        resolution = {
          resolutionNote: note,
          hoursSpent: chance(0.88) ? hours : null,
          followedKnownFix: linkedBeforeVerification ? chance(0.9) : null,
          resolvedAt: new Date(fvAt),
        };
      }

      // When an editor wrote the entry from a group, the issues it skipped were dismissed with it
      const straggler =
        !linked &&
        entry &&
        entry.activeFrom != null &&
        createdAt < entry.activeFrom &&
        entry.activeFrom <= now;

      rows.issues.push({
        id: issueId,
        repairTicketId: ticketId,
        description: `[${problem.category}] ${rootCause}: ${report}`,
        categoryId: categoryId.get(problem.category)!,
        knowledgeEntryId: linked ? entry!.id : null,
        ...resolution,
        suggestionDismissedAt: straggler ? new Date(entry.activeFrom!) : null,
        createdAt: new Date(createdAt + index),
        updatedAt: new Date(
          Math.max(
            createdAt,
            reachedVerification ? fvAt : createdAt,
            linked ? linkAt! : createdAt,
          ),
        ),
      });
      issueMeta.push({
        id: issueId,
        ticketId,
        problem,
        entryId: linked ? entry!.id : null,
        createdAt,
        closed: !isOpen,
        cancelled: status === RepairStatus.CANCELLED,
      });
    });

    if (reachedVerification) {
      audit(
        ticketId,
        fvAt,
        worker,
        statusEvent(
          RepairStatus.IN_PROGRESS,
          RepairStatus.FOR_VERIFICATION,
          remarks,
        ),
      );
      lastChange = fvAt;
    }

    // ── Costs ──
    let partsCost: number | null = null;
    let laborCost: number | null = null;
    let isLumpSum = false;
    let ticketParts: Prisma.RepairPartCreateManyInput[] = [];
    if (costsIn) {
      const lines = problems.flatMap((p) =>
        p.parts
          .filter((part) => chance(part.p ?? 1))
          .map((part) => {
            const quantity = part.qty ? int(part.qty[0], part.qty[1]) : 1;
            const unitCost = peso(between(part.price[0], part.price[1]));
            return {
              description: part.name,
              unitCost,
              quantity,
              subtotal: unitCost * quantity,
            };
          }),
      );
      if (lines.length === 0) {
        const part = problems[0].parts[0];
        const unitCost = peso(between(part.price[0], part.price[1]));
        lines.push({
          description: part.name,
          unitCost,
          quantity: 1,
          subtotal: unitCost,
        });
      }
      const labourHours = issueHours.reduce((a, b) => a + b, 0);
      isLumpSum = chance(0.05);
      partsCost = isLumpSum
        ? peso(
            lines.reduce((s, l) => s + l.subtotal, 0) * between(1.05, 1.2),
            50,
          )
        : lines.reduce((s, l) => s + l.subtotal, 0);
      laborCost = peso(
        labourHours * between(380, 460),
        50,
      );
      ticketParts = isLumpSum
        ? []
        : lines.map((l, i) => ({
            id: uuid(),
            repairTicketId: ticketId,
            ...l,
            createdAt: new Date(costAt + i),
          }));
      audit(
        ticketId,
        costAt,
        ADMIN,
        costEvent(
          { partsCost: null, laborCost: null, totalCost: null, isLumpSum: false },
          { partsCost, laborCost, totalCost: partsCost + laborCost, isLumpSum },
        ),
      );
      lastChange = costAt;
    }

    if (status === RepairStatus.CLOSED) {
      audit(
        ticketId,
        completeAt,
        ADMIN,
        statusEvent(RepairStatus.FOR_VERIFICATION, RepairStatus.CLOSED),
      );
      lastChange = completeAt;
    }
    if (status === RepairStatus.CANCELLED) {
      audit(
        ticketId,
        cancelAt,
        ADMIN,
        statusEvent(
          cancelFromProgress ? RepairStatus.IN_PROGRESS : RepairStatus.ASSIGNED,
          RepairStatus.CANCELLED,
          cancellationReason,
        ),
      );
      lastChange = cancelAt;
    }

    // A late invoice: unlocked, costs corrected, locked again by the save
    let unlockReason: string | null = null;
    const unlockAt = completeAt + between(1, 5) * DAY;
    if (
      status === RepairStatus.CLOSED &&
      partsCost != null &&
      laborCost != null &&
      unlockAt < now &&
      chance(0.03)
    ) {
      unlockReason = pick(UNLOCK_REASONS);
      const before = {
        partsCost,
        laborCost,
        totalCost: partsCost + laborCost,
        isLumpSum,
      };
      if (unlockReason.startsWith('Labor cost was encoded twice'))
        laborCost = peso(laborCost / 2, 50);
      else if (unlockReason.startsWith('Outside shop'))
        laborCost += peso(between(300, 800), 50);
      else if (ticketParts.length) {
        const first = ticketParts[0];
        first.unitCost = peso(Number(first.unitCost) * between(1.08, 1.25));
        first.subtotal = Number(first.unitCost) * first.quantity!;
        partsCost = ticketParts.reduce((s, p) => s + Number(p.subtotal), 0);
      } else partsCost = peso(partsCost * between(1.08, 1.2), 50);
      audit(ticketId, unlockAt, ADMIN, unlockEvent(unlockReason));
      const savedAt = unlockAt + between(5, 30) * 60_000;
      audit(
        ticketId,
        savedAt,
        ADMIN,
        costEvent(before, {
          partsCost,
          laborCost,
          totalCost: partsCost + laborCost,
          isLumpSum,
        }),
      );
      lastChange = savedAt;
    }
    rows.parts.push(...ticketParts);

    rows.tickets.push({
      id: ticketId,
      repairNumber,
      repairStatus: status,
      priority,
      vehicleId: vehicle.id,
      driverId: driver.id,
      garageId: garage.id,
      odometer: km,
      reportedByUserId: VRMS_ADMIN.id,
      reportedByName: VRMS_ADMIN.name,
      // Whoever closes a ticket verified it (Admin today)
      ...(status === RepairStatus.CLOSED && {
        verifiedByUserId: VRMS_ADMIN.id,
        verifiedByName: VRMS_ADMIN.name,
        verifiedAt: new Date(completeAt),
      }),
      partsCost,
      laborCost,
      totalCost:
        partsCost != null && laborCost != null ? partsCost + laborCost : null,
      isLumpSum,
      cancellationReason,
      remarks,
      unlockReason,
      createdAt: new Date(createdAt),
      updatedAt: new Date(lastChange),
      // Set again from the newest audit row before writing (AC-15)
      lastActivityAt: new Date(lastChange),
      closedAt: closedAt ? new Date(closedAt) : null,
    });
    for (const c of crew) {
      rows.assignments.push({
        id: uuid(),
        repairTicketId: ticketId,
        mechanicId: c.id,
        assignedAt: new Date(createdAt),
        assignedByUserId: VRMS_ADMIN.id,
        assignedByName: VRMS_ADMIN.name,
      });
    }
    counts[status]++;

    return { status, closedAt };
  }

  // One closed ticket from the last few days is unlocked right now, waiting for its fix
  const recent = shuffle(
    rows.tickets.filter(
      (t) =>
        t.repairStatus === RepairStatus.CLOSED && now - +t.closedAt! < 4 * DAY,
    ),
  )[0];
  if (recent) {
    const at = Math.min(now - HOUR, +recent.closedAt! + between(2, 20) * HOUR);
    recent.isUnlocked = true;
    recent.unlockReason = UNLOCK_REASONS[0];
    recent.updatedAt = new Date(at);
    audit(recent.id!, at, ADMIN, unlockEvent(UNLOCK_REASONS[0]));
  }

  // lastActivityAt is the newest audit row's time, as the API keeps it (spec 0010, AC-10)
  const newest = new Map<string, number>();
  for (const a of rows.audits) {
    const at = +(a.createdAt as Date);
    if (at > (newest.get(a.repairTicketId) ?? 0))
      newest.set(a.repairTicketId, at);
  }
  for (const t of rows.tickets) t.lastActivityAt = new Date(newest.get(t.id!)!);

  // ── Mechanic suggestions still waiting for an editor ──
  const recentIssue = (match: (m: IssueMeta) => boolean) =>
    shuffle(
      issueMeta.filter((m) => match(m) && now - m.createdAt < 60 * DAY),
    )[0];
  const demoEmails = crews
    .filter((c) => c.demo && c.email)
    .map((c) => c.email!);
  const entryByName = new Map([...entries.values()].map((e) => [e.name, e]));
  const suggestions: Prisma.KnowledgeSuggestionCreateManyInput[] = [];
  for (const s of CHANGE_SUGGESTIONS.slice(0, 3)) {
    const entry = entryByName.get(s.entry)!;
    suggestions.push({
      id: uuid(),
      kind: 'CHANGE',
      entryId: entry.id,
      repairIssueId: recentIssue((m) => m.entryId === entry.id)?.id ?? null,
      body: s.body,
      createdByEmail: pick(demoEmails),
      createdAt: new Date(duringShopHours(now - between(1, 20) * DAY)),
    });
  }
  NEW_ENTRY_SUGGESTIONS.forEach((body, i) => {
    const key = i === 0 ? 'cargo-door' : 'aircon';
    suggestions.push({
      id: uuid(),
      kind: 'NEW_ENTRY',
      repairIssueId:
        recentIssue((m) => m.problem.key === key && !m.entryId)?.id ?? null,
      body,
      createdByEmail: pick(demoEmails),
      createdAt: new Date(duringShopHours(now - between(1, 12) * DAY)),
    });
  });

  // The chief already dismissed the horn group; aircon and cargo doors stay as live suggestions
  const dismissedAt = new Date(duringShopHours(now - 3 * DAY));
  const hornIds = new Set(
    issueMeta
      .filter(
        (m) =>
          m.problem.key === 'horn' &&
          !m.entryId &&
          !m.cancelled &&
          +m.createdAt < +dismissedAt,
      )
      .map((m) => m.id),
  );
  for (const issue of rows.issues)
    if (hornIds.has(issue.id!)) issue.suggestionDismissedAt = dismissedAt;

  // ── Write ──
  const chunked = async <T>(
    items: T[],
    size: number,
    write: (part: T[]) => Promise<unknown>,
  ) => {
    for (let i = 0; i < items.length; i += size)
      await write(items.slice(i, i + size));
  };
  await chunked(rows.tickets, 500, (data) =>
    prisma.repairTicket.createMany({ data }),
  );
  await chunked(rows.assignments, 1000, (data) =>
    prisma.ticketAssignment.createMany({ data }),
  );
  await chunked(rows.issues, 500, (data) =>
    prisma.repairIssue.createMany({ data }),
  );
  await chunked(rows.steps, 1000, (data) =>
    prisma.repairIssueStep.createMany({ data }),
  );
  await chunked(rows.parts, 1000, (data) =>
    prisma.repairPart.createMany({ data }),
  );
  await chunked(rows.audits, 1000, (data) =>
    prisma.auditLog.createMany({ data }),
  );
  await prisma.knowledgeSuggestion.createMany({ data: suggestions });

  for (const v of vehicleUpdates) {
    await prisma.vehicle.update({
      where: { id: v.id },
      data: {
        odometer: v.odometer,
        status: v.retiredAt ? VehicleStatus.AVAILABLE : v.status,
        isActive: !v.retiredAt,
        deletedAt: v.retiredAt ? new Date(v.retiredAt) : null,
      },
    });
  }

  const linked = rows.issues.filter((i) => i.knowledgeEntryId).length;
  console.log(
    `  ${rows.tickets.length} tickets: ${counts.CLOSED} closed, ${counts.CANCELLED} cancelled, ` +
      `${counts.ASSIGNED} assigned, ${counts.IN_PROGRESS} in progress, ${counts.FOR_VERIFICATION} for verification`,
  );
  console.log(
    `  ${rows.issues.length} issues (${linked} linked to a known fix), ${rows.steps.length} checklist steps, ` +
      `${rows.parts.length} parts lines, ${rows.audits.length} audit rows, ${suggestions.length} open suggestions\n`,
  );
}
