import {
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service';
import { Public } from '../auth/permissions/permission.decorators';
import { PermissionsService } from '../auth/permissions/permissions.service';

export type HealthCheck = 'ok' | 'failed';

/** How long a check may take before it counts as failed (spec 0008, AC-22 and AC-23). */
export const HEALTH_TIMEOUT_MS = 2000;

/**
 * `ok` when the work settles in time, `failed` when it throws or is slower than `ms`. This only
 * stops waiting: Prisma can't cancel a query that is already running.
 */
export async function checkWithin(
  work: PromiseLike<unknown>,
  ms: number,
): Promise<HealthCheck> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<HealthCheck>((resolve) => {
    timer = setTimeout(() => resolve('failed'), ms);
  });
  const outcome = Promise.resolve(work).then(
    (): HealthCheck => 'ok',
    (): HealthCheck => 'failed',
  );
  try {
    return await Promise.race([outcome, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET /vrms/health` for the gateway and the host's probes (spec 0008, AC-23): the database and
 * the permission matrix. Public, and it shows only ok or failed, never the error behind a failure.
 * The root route in AppController stays as it is.
 */
@Controller('vrms')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  @Public()
  @Get('health')
  @Header('Cache-Control', 'no-store')
  async health() {
    const database = await checkWithin(
      this.prisma.$queryRaw`SELECT 1`,
      HEALTH_TIMEOUT_MS,
    );
    const permissions: HealthCheck = this.permissions.isReady ? 'ok' : 'failed';
    const checks = { database, permissions };
    if (database !== 'ok' || permissions !== 'ok') {
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'A health check failed',
          error: 'Service Unavailable',
          code: 'HEALTH_CHECK_FAILED',
          status: 'unavailable',
          checks,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'ok', checks };
  }
}
