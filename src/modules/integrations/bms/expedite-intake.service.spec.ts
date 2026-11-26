import {
  HttpException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../shared/prisma.service';
import { payloadHash } from '../referrals/referral-intake';
import type { ExpediteRequestDto } from './bms-integration.dto';
import { ExpediteIntakeService } from './expedite-intake.service';

// covers: spec 0029 AC-18 and AC-25 (BMS expedite intake, child 0003)

const NOW = new Date('2026-11-28T02:00:00.000Z');

/** The refusal a call ends in, typed for the assertions. */
const refusal = (call: Promise<unknown>): Promise<HttpException> =>
  call.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: HttpException) => error,
  );
const body: ExpediteRequestDto = {
  requestId: '6f1c1e7a-2b3c-4d5e-8f90-a1b2c3d4e5f6',
  vmmsVehicleId: '0b5e1f2a-3c4d-4e5f-8a9b-1c2d3e4f5a6b',
  jobOrderNumber: 'JO-2026-0142',
  reason: 'Booked for a Batangas run on Monday',
  neededBy: '2026-12-01',
};

function setup(opts: {
  stored?: Record<string, unknown> | null;
  open?: { id: string; repairNumber: string } | null;
}) {
  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValue(
        opts.open === null
          ? []
          : [opts.open ?? { id: 't1', repairNumber: 'REP-20261128-0003' }],
      ),
    expediteRequest: { create: jest.fn().mockResolvedValue({}) },
    auditLog: {
      create: jest
        .fn<Promise<object>, [{ data: Record<string, unknown> }]>()
        .mockResolvedValue({}),
    },
  };
  const prisma = {
    expediteRequest: {
      findUnique: jest.fn().mockResolvedValue(opts.stored ?? null),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const service = new ExpediteIntakeService(prisma as unknown as PrismaService);
  return { service, prisma, tx };
}

describe('ExpediteIntakeService.receive', () => {
  it('stores the request WAITING on the open ticket and audits it as BMS', async () => {
    const { service, tx } = setup({});
    await expect(service.receive(body, body, NOW)).resolves.toEqual({
      requestId: body.requestId,
      status: 'WAITING',
      repairTicketNumber: 'REP-20261128-0003',
      duplicate: false,
    });
    expect(tx.expediteRequest.create).toHaveBeenCalledWith({
      data: {
        id: body.requestId,
        repairTicketId: 't1',
        jobOrderNumber: 'JO-2026-0142',
        reason: body.reason,
        neededBy: new Date('2026-12-01T00:00:00Z'),
        receivedAt: NOW,
        payloadHash: payloadHash(body),
      },
    });
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      repairTicketId: 't1',
      action: 'EXPEDITE_REQUESTED',
      actorRole: 'SYSTEM',
      actorName: 'BMS',
      changes: [{ field: 'expedite', before: null, after: 'JO-2026-0142' }],
      note: body.reason,
    });
  });

  it('answers 404 NO_OPEN_REPAIR for a truck with no open ticket', async () => {
    const { service, tx } = setup({ open: null });
    const error = await refusal(service.receive(body, body, NOW));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.getResponse()).toMatchObject({ code: 'NO_OPEN_REPAIR' });
    expect(tx.expediteRequest.create).not.toHaveBeenCalled();
  });

  it('answers a resend with the stored answer, and refuses a changed body', async () => {
    const stored = {
      status: 'ACCEPTED',
      payloadHash: payloadHash(body),
      repairTicket: { repairNumber: 'REP-20261128-0003' },
    };
    const same = setup({ stored });
    await expect(same.service.receive(body, body, NOW)).resolves.toEqual({
      requestId: body.requestId,
      status: 'ACCEPTED',
      repairTicketNumber: 'REP-20261128-0003',
      duplicate: true,
    });
    expect(same.prisma.$transaction).not.toHaveBeenCalled();

    const changed = { ...body, reason: 'A different reason' };
    const error = await refusal(same.service.receive(changed, changed, NOW));
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: 'REQUEST_ID_REUSED' });
  });

  it('answers a lost race as a resend', async () => {
    const { service, prisma } = setup({});
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    prisma.expediteRequest.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        status: 'WAITING',
        payloadHash: payloadHash(body),
        repairTicket: { repairNumber: 'REP-20261128-0003' },
      });
    await expect(service.receive(body, body, NOW)).resolves.toMatchObject({
      duplicate: true,
    });
  });
});
