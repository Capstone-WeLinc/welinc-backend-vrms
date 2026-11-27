import { NotFoundException } from '@nestjs/common';
import { KnowledgeEntryStatus } from '@prisma/client';
import { UserRole } from '../../auth/built-in-roles.testing';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { PrismaService } from '../../shared/prisma.service';
import { KnowledgeEntriesService } from './knowledge-entries.service';
import * as stats from './knowledge-stats';
import { FakeSettings } from '../../settings/settings.fake';

// Spec 0011, AC-13: a knowledge.view reader sees Active entries only and gets 404 for any other;
// knowledge.edit sees every status, plus typical costs and recent tickets.

const as = (role: UserRole) =>
  defaultAbility({ sub: role, roles: [{ role, system: 'VRMS' }] });

function setup(status: KnowledgeEntryStatus) {
  jest.spyOn(stats, 'loadStats').mockResolvedValue(
    new Map([
      [
        'e1',
        {
          seenCount: 3,
          lastSeenAt: null,
          typicalHours: 2,
          hoursSamples: 3,
          typicalDays: 1,
          typicalCost: 1500,
        },
      ],
    ]),
  );
  jest.spyOn(stats, 'loadRepeatVehicles').mockResolvedValue([]);
  const prisma = {
    knowledgeEntry: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'e1',
        name: 'Brake pads worn',
        status,
        category: { id: 'c1', name: 'Brakes', isActive: true },
        steps: [],
        parts: [],
        estimatedHours: null,
      }),
    },
    repairTicket: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return new KnowledgeEntriesService(
    prisma as unknown as PrismaService,
    new FakeSettings(),
  );
}

afterEach(() => jest.restoreAllMocks());

describe('KnowledgeEntriesService.findOne on the ability (AC-13)', () => {
  it('answers 404 to a mechanic for a draft', async () => {
    await expect(
      setup(KnowledgeEntryStatus.DRAFT).findOne('e1', as(UserRole.MECHANIC)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('shows a mechanic an active entry without typical costs or recent tickets', async () => {
    const res = await setup(KnowledgeEntryStatus.ACTIVE).findOne(
      'e1',
      as(UserRole.MECHANIC),
    );
    expect(res.stats).not.toHaveProperty('typicalCost');
    expect(res).not.toHaveProperty('recentTickets');
  });

  it('shows a chief mechanic a draft with typical costs', async () => {
    const res = await setup(KnowledgeEntryStatus.DRAFT).findOne(
      'e1',
      as(UserRole.CHIEF_MECHANIC),
    );
    expect(res.status).toBe(KnowledgeEntryStatus.DRAFT);
    expect(res.stats).toHaveProperty('typicalCost', 1500);
  });
});
