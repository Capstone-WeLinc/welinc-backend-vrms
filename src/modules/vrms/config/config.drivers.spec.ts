import { NotFoundException } from '@nestjs/common';
import { defaultAbility } from '../../../auth/permissions/permissions.fake';
import { UserRole } from '../../../auth/built-in-roles.testing';
import { PrismaService } from '../../../shared/prisma.service';
import { LookupsService } from '../lookups/lookups.service';
import { ConfigService } from './config.service';

// Spec 0016, AC-13 and AC-19: the driver search and the lookup read.

function user(role: UserRole) {
  return {
    sub: '00000000-0000-4000-8000-000000000001',
    email: `${role.toLowerCase()}@welinc.com`,
    name: role,
    roles: [{ role, system: 'VRMS' }],
    system: 'VRMS',
  };
}

describe('ConfigService.listDrivers', () => {
  const rows = [{ id: 'd1', name: 'Ana', licenseNumber: 'A01-23-456789' }];
  function setup() {
    const prisma = { driver: { findMany: jest.fn().mockResolvedValue(rows) } };
    return {
      prisma,
      service: new ConfigService(prisma as unknown as PrismaService),
    };
  }

  it('searches active drivers by name or license, 20 at most, by name', async () => {
    const { prisma, service } = setup();
    await service.listDrivers(' ana ', defaultAbility(user(UserRole.ADMIN)));
    expect(prisma.driver.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          deletedAt: null,
          OR: [
            { name: { contains: 'ana', mode: 'insensitive' } },
            { licenseNumber: { contains: 'ana', mode: 'insensitive' } },
          ],
        },
        orderBy: { name: 'asc' },
        take: 20,
      }),
    );
  });

  it('adds no filter without q', async () => {
    const { prisma, service } = setup();
    await service.listDrivers(undefined, defaultAbility(user(UserRole.ADMIN)));
    expect(prisma.driver.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, deletedAt: null } }),
    );
  });

  it('returns the license number to a caller who can create tickets', async () => {
    const { service } = setup();
    const result = await service.listDrivers(
      undefined,
      defaultAbility(user(UserRole.ADMIN)),
    );
    expect(result).toEqual(rows);
  });

  it('never returns the license number to a Mechanic', async () => {
    const { service } = setup();
    const result = await service.listDrivers(
      undefined,
      defaultAbility(user(UserRole.MECHANIC)),
    );
    expect(result).toEqual([{ id: 'd1', name: 'Ana' }]);
  });
});

describe('LookupsService.listActive', () => {
  it('lists active values by sort order then name', async () => {
    const prisma = {
      lookupValue: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new LookupsService(prisma as unknown as PrismaService);
    await service.listActive('corporation');
    expect(prisma.lookupValue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { list: 'corporation', isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  });

  it('answers 404 for an unknown list', async () => {
    const prisma = { lookupValue: { findMany: jest.fn() } };
    const service = new LookupsService(prisma as unknown as PrismaService);
    await expect(service.listActive('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.lookupValue.findMany).not.toHaveBeenCalled();
  });
});
