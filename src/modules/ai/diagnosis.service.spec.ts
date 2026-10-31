import { NotFoundException } from '@nestjs/common';
import { RepairStatus } from '@prisma/client';
import type { AuthUser } from '../../auth/account-check';
import { defaultAbility } from '../../auth/permissions/permissions.fake';
import { UserRole } from '../../auth/roles';
import { FakeSettings } from '../../settings/settings.fake';
import type { PrismaService } from '../../shared/prisma.service';
import { AiProviderError } from './ai-provider';
import { FakeAiProvider, fakeVector } from './ai-provider.fake';
import { HOURLY_LIMIT, DiagnosisService } from './diagnosis.service';
import type { EmbeddingService } from './embedding.service';

// Spec 0013, AC-7 to AC-11: the diagnosis service on a fake provider and a fake database.

const TICKET = '00000000-0000-4000-8000-0000000000aa';

const admin: AuthUser = {
  sub: 'admin',
  email: 'admin@welinc.com',
  name: 'Admin',
  system: 'VRMS',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
};
const chief: AuthUser = {
  ...admin,
  sub: 'chief',
  roles: [{ role: UserRole.MECHANIC, system: 'VRMS' }],
};

const goodReply = {
  summary: 'Worn brake pads.',
  predictedCategory: 'brakes',
  predictedPriority: 'HIGH',
  estimatedHours: 3,
  probableCauses: ['Pads worn thin'],
  recommendedParts: [{ partName: 'Brake pads' }],
  safetyNote: 'Do not drive loaded.',
};

function ticket(status: RepairStatus = RepairStatus.IN_PROGRESS) {
  return {
    id: TICKET,
    vehicleId: 'veh-1',
    repairStatus: status,
    vehicle: { plateNumber: 'ABC 123', model: 'Isuzu Giga' },
    issues: [
      { description: '[Brakes] Pads worn: squeal on stop' },
      { description: 'Pulls to the left' },
    ],
  };
}

type Setup = {
  ticketRow?: ReturnType<typeof ticket> | null;
  locked?: boolean;
  recentRuns?: { createdAt: Date }[];
  avgCost?: number | null;
};

function setup({
  ticketRow = ticket(),
  locked = true,
  recentRuns = [],
  avgCost = 1200,
}: Setup = {}) {
  const provider = new FakeAiProvider();
  provider.reply = goodReply;

  const created: Record<string, unknown>[] = [];
  const queryRaw = jest.fn();
  // Calls in order: advisory lock, similar cases, then one price per recommended part
  queryRaw
    .mockResolvedValueOnce([{ locked }])
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ avg: avgCost }]);
  const tx = {
    $queryRaw: queryRaw,
    aiDiagnosis: {
      findMany: jest.fn().mockResolvedValue(recentRuns),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: 'diag-1',
          createdAt: new Date(),
          repairTicketId: TICKET,
          ...data,
        };
        created.push(row);
        return Promise.resolve(row);
      }),
    },
    repairTicket: { findMany: jest.fn().mockResolvedValue([]) },
    issueCategory: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ name: 'Brakes' }, { name: 'General' }]),
    },
  };
  const prisma = {
    repairTicket: { findFirst: jest.fn().mockResolvedValue(ticketRow) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const embeddings = {
    model: 'fake-embed',
    embedQuery: jest.fn(() => Promise.resolve(fakeVector('x'))),
  };
  const service = new DiagnosisService(
    prisma as unknown as PrismaService,
    new FakeSettings(),
    embeddings as unknown as EmbeddingService,
    provider,
  );
  return { service, provider, prisma, tx, created };
}

describe('DiagnosisService.run', () => {
  it('stores one row built from the ticket and prices the parts (AC-7, AC-8, AC-9)', async () => {
    const { service, provider, created } = setup();

    const view = await service.run(TICKET, admin, defaultAbility(admin));

    expect(created).toHaveLength(1);
    expect(view.symptom).toBe('Pads worn: squeal on stop. Pulls to the left');
    expect(view.result.predictedCategory).toBe('Brakes');
    expect(view.result.recommendedParts).toEqual([
      { partName: 'Brake pads', estCostPhp: 1200 },
    ]);
    expect(provider.prompts[0]).toContain('ABC 123');
  });

  it('hides part prices from a caller without ticket.costs.view (AC-8)', async () => {
    const { service } = setup();

    const view = await service.run(TICKET, chief, defaultAbility(chief));

    expect(view.result.recommendedParts[0].estCostPhp).toBeNull();
  });

  it('answers 404 when the caller cannot read the ticket (AC-7)', async () => {
    const { service, provider } = setup({ ticketRow: null });

    await expect(
      service.run(TICKET, chief, defaultAbility(chief)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(provider.prompts).toHaveLength(0);
  });

  it.each([RepairStatus.CLOSED, RepairStatus.CANCELLED])(
    'answers 409 TICKET_CLOSED on a %s ticket (AC-7)',
    async (status) => {
      const { service, prisma } = setup({ ticketRow: ticket(status) });

      await expect(
        service.run(TICKET, admin, defaultAbility(admin)),
      ).rejects.toMatchObject({
        response: { code: 'TICKET_CLOSED' },
        status: 409,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('answers 409 AI_BUSY when another run holds the ticket lock (AC-11)', async () => {
    const { service, provider } = setup({ locked: false });

    await expect(
      service.run(TICKET, admin, defaultAbility(admin)),
    ).rejects.toMatchObject({ response: { code: 'AI_BUSY' }, status: 409 });
    expect(provider.prompts).toHaveLength(0);
  });

  it('answers 429 AI_RATE_LIMITED on the 21st run in an hour (AC-11)', async () => {
    const recentRuns = Array.from({ length: HOURLY_LIMIT }, () => ({
      createdAt: new Date(Date.now() - 30 * 60 * 1000),
    }));
    const { service, created } = setup({ recentRuns });

    const error: unknown = await service
      .run(TICKET, admin, defaultAbility(admin))
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      status: 429,
      response: { code: 'AI_RATE_LIMITED' },
    });
    const { retryAfterSeconds } = (
      error as { response: { retryAfterSeconds: number } }
    ).response;
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(retryAfterSeconds).toBeLessThanOrEqual(1800);
    expect(created).toHaveLength(0);
  });

  it('allows the 20th run (AC-11)', async () => {
    const recentRuns = Array.from({ length: HOURLY_LIMIT - 1 }, () => ({
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    }));
    const { service } = setup({ recentRuns });

    await expect(
      service.run(TICKET, admin, defaultAbility(admin)),
    ).resolves.toBeDefined();
  });

  it('answers 503 AI_UNAVAILABLE and stores nothing when the provider times out (AC-10)', async () => {
    const { service, provider, created } = setup();
    provider.failWith = new AiProviderError('Timed out after 20 seconds');

    await expect(
      service.run(TICKET, admin, defaultAbility(admin)),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'AI_UNAVAILABLE' },
    });
    expect(created).toHaveLength(0);
  });

  it('answers 503 AI_UNAVAILABLE on a reply that fails validation (AC-10)', async () => {
    const { service, provider, created } = setup();
    provider.reply = { ...goodReply, estimatedHours: 0 };

    await expect(
      service.run(TICKET, admin, defaultAbility(admin)),
    ).rejects.toMatchObject({ response: { code: 'AI_UNAVAILABLE' } });
    expect(created).toHaveLength(0);
  });

  it('answers 503 AI_UNAVAILABLE when the reply is not a JSON object (AC-10)', async () => {
    const { service, provider } = setup();
    provider.reply = 'not json';

    await expect(
      service.run(TICKET, admin, defaultAbility(admin)),
    ).rejects.toMatchObject({ response: { code: 'AI_UNAVAILABLE' } });
  });

  it('answers 503 AI_UNAVAILABLE with no key and calls nothing (AC-20)', async () => {
    const { service, provider } = setup();
    provider.configured = false;

    await expect(
      service.run(TICKET, admin, defaultAbility(admin)),
    ).rejects.toMatchObject({ response: { code: 'AI_UNAVAILABLE' } });
    expect(provider.prompts).toHaveLength(0);
  });
});
