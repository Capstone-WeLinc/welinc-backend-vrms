import { describe, it, expect } from '@jest/globals';
import { HttpException } from '@nestjs/common';
import { HealthController, checkWithin } from './health.controller';
import type { PrismaService } from '../shared/prisma.service';
import type { PermissionsService } from '../auth/permissions/permissions.service';

const controllerWith = (queryRaw: () => Promise<unknown>, isReady = true) =>
  new HealthController(
    { $queryRaw: queryRaw } as unknown as PrismaService,
    { isReady } as unknown as PermissionsService,
  );

const failureOf = async (controller: HealthController) => {
  const error = await controller.health().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
};

describe('checkWithin', () => {
  it('is ok when the work settles in time', async () => {
    await expect(checkWithin(Promise.resolve(1), 50)).resolves.toBe('ok');
  });

  it('fails when the work throws', async () => {
    await expect(
      checkWithin(Promise.reject(new Error('down')), 50),
    ).resolves.toBe('failed');
  });

  it('fails when the work is slower than the limit', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(checkWithin(slow, 20)).resolves.toBe('failed');
  });
});

describe('HealthController', () => {
  it('answers ok with both checks', async () => {
    await expect(
      controllerWith(() => Promise.resolve([])).health(),
    ).resolves.toEqual({
      status: 'ok',
      checks: { database: 'ok', permissions: 'ok' },
    });
  });

  it('answers 503 with no error text when the database fails', async () => {
    const http = await failureOf(
      controllerWith(() => Promise.reject(new Error('connection refused'))),
    );
    expect(http.getStatus()).toBe(503);
    expect(http.getResponse()).toEqual({
      statusCode: 503,
      message: 'A health check failed',
      error: 'Service Unavailable',
      code: 'HEALTH_CHECK_FAILED',
      status: 'unavailable',
      checks: { database: 'failed', permissions: 'ok' },
    });
    expect(JSON.stringify(http.getResponse())).not.toContain('refused');
  });

  it('answers 503 until the permission matrix has loaded', async () => {
    const http = await failureOf(
      controllerWith(() => Promise.resolve([]), false),
    );
    expect(http.getStatus()).toBe(503);
    expect(http.getResponse()).toMatchObject({
      checks: { database: 'ok', permissions: 'failed' },
    });
  });
});
