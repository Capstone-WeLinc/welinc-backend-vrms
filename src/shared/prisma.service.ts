import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import type { Env } from '../config/env';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnApplicationShutdown
{
  private readonly pool: pg.Pool;

  constructor(config: ConfigService<Env, true>) {
    const pool = new pg.Pool({
      connectionString: config.get('DATABASE_URL', { infer: true }),
    });
    const adapter = new PrismaPg(pool);

    super({ adapter });

    this.pool = pool;
  }

  async onApplicationShutdown() {
    await this.$disconnect();
    await this.pool.end();
  }
}
