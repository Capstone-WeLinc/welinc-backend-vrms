import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import { buildAbility } from '../../auth/permissions/ability.factory';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { PrismaService } from '../../shared/prisma.service';
import { FakeSettings } from '../../settings/settings.fake';
import { FakeEmbeddings } from '../ai/embedding.fake';
import { FakeFleet } from '../integrations/fleet/vmms-fleet.fake';
import { NavCountsService } from './nav-counts.service';
import {
  readView,
  REPAIR_VIEWS,
  viewWhere,
  type ViewCaller,
} from './repair-views';
import { RepairsService } from './repairs.service';
import { readableTickets } from './ticket-access';
import { OPEN_STATUSES } from './ticket-statuses';

jest.mock('../integrations/vmms-repair-events', () => ({
  queueVmmsRepairEvent: jest.fn().mockResolvedValue({ skipped: 'NOT_LINKED' }),
}));

const role = (code: string) => [{ role: code, system: 'VRMS' }] as never;
const chief = defaultAbility({ sub: 'c', roles: role('CHIEF_MECHANIC') });
const admin = defaultAbility({ sub: 'a', roles: role('ADMIN') });
const mechanic = defaultAbility({ sub: 'm', roles: role('MECHANIC') });
const nobody = buildAbility('x', new Set());

const caller = (
  sub: string,
  ability: ViewCaller['ability'],
  inRoster = false,
): ViewCaller => ({ sub, ability, inRoster });

/** A Prisma stand in that records each count's where; `inRoster` answers the roster lookup. */
function fakePrisma(inRoster: boolean) {
  const prisma = {
    mechanic: {
      findFirst: jest.fn().mockResolvedValue(inRoster ? { id: 'row' } : null),
    },
    repairTicket: {
      count: jest.fn().mockResolvedValue(4),
      findMany: jest.fn().mockResolvedValue([]),
    },
    knowledgeSuggestion: { count: jest.fn().mockResolvedValue(2) },
    $transaction: jest.fn((queries: Promise<number>[]) => Promise.all(queries)),
  };
  return prisma;
}

const listService = (prisma: ReturnType<typeof fakePrisma>) =>
  new RepairsService(
    prisma as unknown as PrismaService,
    new FakeSettings(),
    new FakeEmbeddings().asService(),
    new FakeFleet().asClient(),
  );

// covers: spec 0027 AC-2, AC-4
describe('view presets', () => {
  it('answers 400 VALIDATION_FAILED to an unknown view', () => {
    expect(() => readView('bogus', caller('c', chief))).toThrow(
      BadRequestException,
    );
    try {
      readView('bogus', caller('c', chief));
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('answers 403 to a view the caller cannot use', () => {
    expect(() => readView('mine', caller('a', admin, false))).toThrow(
      ForbiddenException,
    );
    expect(() => readView('open', caller('m', mechanic))).toThrow(
      ForbiddenException,
    );
    expect(() => readView('sentBack', caller('x', nobody))).toThrow(
      ForbiddenException,
    );
    expect(readView('mine', caller('c', chief, true))).toBe('mine');
    expect(readView('sentBack', caller('m', mechanic))).toBe('sentBack');
  });

  it('leaves the caller’s own tickets out of Waiting for sign off (spec 0014)', () => {
    expect(viewWhere('signoff', 'c')).toEqual({
      repairStatus: RepairStatus.FOR_VERIFICATION,
      assignments: { none: { mechanic: { is: { authUserId: 'c' } } } },
    });
  });

  it('keeps Done to Closed tickets and Sent back to In progress ones with a send back in force', () => {
    expect(JSON.stringify(viewWhere('done', 'm'))).toContain(
      '"repairStatus":"CLOSED"',
    );
    expect(JSON.stringify(viewWhere('done', 'm'))).not.toContain('CANCELLED');
    expect(viewWhere('sentBack', 'm')).toMatchObject({
      AND: [
        { repairStatus: RepairStatus.IN_PROGRESS, sentBackAt: { not: null } },
        expect.anything(),
      ],
    });
  });

  it('narrows the list: the scope stays, the open default gives way to the view, a status applies on top', async () => {
    const prisma = fakePrisma(false);
    await listService(prisma).findAll({ view: 'done' }, mechanic, 'm');
    const where = (
      prisma.repairTicket.count.mock.calls[0] as [
        { where: Record<string, unknown> },
      ]
    )[0].where;

    expect(where.repairStatus).toBeUndefined();
    expect(where.AND).toEqual([
      readableTickets(mechanic),
      viewWhere('done', 'm'),
    ]);

    const withStatus = fakePrisma(false);
    await listService(withStatus).findAll(
      { view: 'open', status: RepairStatus.ASSIGNED },
      chief,
      'c',
    );
    const narrowed = (
      withStatus.repairTicket.count.mock.calls[0] as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(narrowed.repairStatus).toBe(RepairStatus.ASSIGNED);
  });

  it('orders Waiting for sign off oldest waiting first, like the For verification list', async () => {
    const prisma = fakePrisma(false);
    await listService(prisma).findAll({ view: 'signoff', page: 1 }, chief, 'c');
    const args = (
      prisma.repairTicket.findMany.mock.calls[0] as [{ orderBy: unknown }]
    )[0];

    expect(args.orderBy).toEqual([{ statusChangedAt: 'asc' }, { id: 'asc' }]);
  });

  it('checks the roster for mine before the list runs', async () => {
    const prisma = fakePrisma(false);
    await expect(
      listService(prisma).findAll({ view: 'mine' }, chief, 'c'),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.repairTicket.count).not.toHaveBeenCalled();
  });

  it('offers a view for every sidebar sub page', () => {
    expect(REPAIR_VIEWS).toEqual([
      'open',
      'signoff',
      'mine',
      'active',
      'sentBack',
      'done',
    ]);
    expect(OPEN_STATUSES).not.toContain(RepairStatus.CLOSED);
  });
});

// covers: spec 0027 AC-5, AC-7
describe('NavCountsService', () => {
  /** The where of each count, in order. */
  const wheres = (prisma: ReturnType<typeof fakePrisma>) =>
    prisma.repairTicket.count.mock.calls.map(
      (call) => (call as [{ where: unknown }])[0].where,
    );

  it('gives a chief in the roster open, signoff and mine, and the suggestions to review', async () => {
    const prisma = fakePrisma(true);
    const counts = await new NavCountsService(
      prisma as unknown as PrismaService,
    ).counts('c', chief);

    expect(counts).toEqual({ open: 4, signoff: 4, mine: 4, suggestions: 2 });
  });

  it('gives an admin outside the roster no mine', async () => {
    const prisma = fakePrisma(false);
    const counts = await new NavCountsService(
      prisma as unknown as PrismaService,
    ).counts('a', admin);

    expect(Object.keys(counts).sort()).toEqual([
      'open',
      'signoff',
      'suggestions',
    ]);
  });

  it('gives a mechanic active and sentBack only, with no count for Done', async () => {
    const prisma = fakePrisma(true);
    const counts = await new NavCountsService(
      prisma as unknown as PrismaService,
    ).counts('m', mechanic);

    expect(counts).toEqual({ active: 4, sentBack: 4 });
    expect(prisma.knowledgeSuggestion.count).not.toHaveBeenCalled();
  });

  it('gives a user with no VRMS keys {}, never an error', async () => {
    const prisma = fakePrisma(false);

    await expect(
      new NavCountsService(prisma as unknown as PrismaService).counts(
        'x',
        nobody,
      ),
    ).resolves.toEqual({});
    expect(prisma.repairTicket.count).not.toHaveBeenCalled();
  });

  it('counts each view with the where its list uses, so a count equals the list total', async () => {
    for (const [sub, ability, views] of [
      ['c', chief, ['open', 'signoff', 'mine']],
      ['m', mechanic, ['active', 'sentBack']],
    ] as const) {
      const counts = fakePrisma(true);
      await new NavCountsService(counts as unknown as PrismaService).counts(
        sub,
        ability,
      );

      for (const [index, view] of views.entries()) {
        const list = fakePrisma(true);
        await listService(list).findAll({ view }, ability, sub);
        const listWhere = (
          list.repairTicket.count.mock.calls[0] as [{ where: { AND: unknown } }]
        )[0].where;
        expect(wheres(counts)[index]).toEqual({ AND: listWhere.AND });
      }
    }
  });
});
