import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '../../../auth/roles';
import { PrismaService } from '../../../shared/prisma.service';
import { LookupsService } from './lookups.service';
import { lookupNameKey } from './lookup-name';

// Spec 0016, AC-19 and AC-20: the lookup write rules.

const admin = {
  sub: '00000000-0000-4000-8000-000000000002',
  email: 'vrms.admin@welinc.com',
  name: 'Victor Ramos',
  roles: [{ role: UserRole.ADMIN, system: 'VRMS' }],
  system: 'VRMS' as const,
};

function setup(
  over: { taken?: unknown; current?: unknown; top?: number } = {},
) {
  const tx = {
    lookupValue: {
      findUnique: jest.fn().mockResolvedValue(over.taken ?? null),
      findFirst: jest.fn().mockResolvedValue(over.current ?? null),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _max: { sortOrder: over.top ?? 60 } }),
      create: jest.fn((args: { data: { name: string; sortOrder: number } }) =>
        Promise.resolve({
          id: 'new',
          isActive: true,
          name: args.data.name,
          sortOrder: args.data.sortOrder,
        }),
      ),
      update: jest.fn((args: { data: { name?: string; isActive?: boolean } }) =>
        Promise.resolve({
          id: 'v1',
          name: args.data.name ?? 'Trailer',
          isActive: args.data.isActive ?? true,
          sortOrder: 60,
        }),
      ),
    },
    lookupValueChange: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((run: (c: typeof tx) => unknown) => run(tx)),
  };
  return {
    tx,
    service: new LookupsService(prisma as unknown as PrismaService),
  };
}

const actions = (tx: ReturnType<typeof setup>['tx']) =>
  (
    tx.lookupValueChange.create.mock.calls as [{ data: { action: string } }][]
  ).map((c) => c[0].data.action);

describe('lookupNameKey', () => {
  it('trims and lowercases', () => {
    expect(lookupNameKey('  Wing Van ')).toBe('wing van');
  });
});

describe('LookupsService', () => {
  it('answers 404 for an unknown list', async () => {
    await expect(setup().service.listActive('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('adds a value at the highest sortOrder plus 10 and logs CREATE', async () => {
    const { service, tx } = setup({ top: 60 });
    const out = await service.create('vehicle_type', { name: 'Reefer' }, admin);
    expect(out.sortOrder).toBe(70);
    expect(actions(tx)).toEqual(['CREATE']);
  });

  it('answers 409 for a duplicate name', async () => {
    const { service, tx } = setup({ taken: { id: 'x' } });
    await expect(
      service.create('corporation', { name: 'Acme' }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.lookupValueChange.create).not.toHaveBeenCalled();
  });

  it('logs a rename, and a deactivate when both change', async () => {
    const { service, tx } = setup({
      current: { id: 'v1', name: 'Trailer', isActive: true, sortOrder: 60 },
    });
    await service.update(
      'vehicle_type',
      'v1',
      { name: 'Flatbed', isActive: false },
      admin,
    );
    expect(actions(tx)).toEqual(['RENAME', 'DEACTIVATE']);
  });

  it('logs REACTIVATE, and writes nothing when nothing changes', async () => {
    const off = { id: 'v1', name: 'Trailer', isActive: false, sortOrder: 60 };
    const first = setup({ current: off });
    await first.service.update('vehicle_type', 'v1', { isActive: true }, admin);
    expect(actions(first.tx)).toEqual(['REACTIVATE']);

    const same = setup({ current: { ...off, isActive: true } });
    await same.service.update(
      'vehicle_type',
      'v1',
      { name: 'Trailer', isActive: true },
      admin,
    );
    expect(same.tx.lookupValue.update).not.toHaveBeenCalled();
  });

  it('refuses a rename to the name of another value', async () => {
    const { service } = setup({
      current: { id: 'v1', name: 'Trailer', isActive: true, sortOrder: 60 },
      taken: { id: 'other' },
    });
    await expect(
      service.update('vehicle_type', 'v1', { name: 'Wing van' }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses an empty patch', async () => {
    await expect(
      setup().service.update('vehicle_type', 'v1', {}, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
