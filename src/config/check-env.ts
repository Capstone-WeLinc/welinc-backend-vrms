import { validateEnv } from './env';

/**
 * `npm run env:check`: the boot check alone, without starting Nest (spec 0010). The production
 * start runs it before `prisma migrate deploy`, since the Prisma CLI reads `process.env` itself.
 */
try {
  validateEnv(process.env);
  console.log('Environment check passed');
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Environment check failed',
  );
  process.exit(1);
}
