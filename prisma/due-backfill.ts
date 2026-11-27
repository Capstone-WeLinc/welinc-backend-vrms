import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { SettingsService } from '../src/settings/settings.service';
import { PrismaService } from '../src/shared/prisma.service';
import { backfillDueDates } from '../src/modules/vrms/due-backfill';

// Spec 0030, AC-13: `npm run due:backfill`. Gives every open ticket with no due date an automatic
// one by the new rules. Run it once locally and once on staging after the deploy. Safe to run again.

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const settings = app.get(SettingsService);
    // The stored settings, not the catalog defaults
    await settings.load();
    const result = await backfillDueDates(
      app.get(PrismaService),
      settings,
      (line) => console.log(line),
    );
    console.log(
      result.written === 0
        ? 'Nothing to do: every open ticket has a due date.'
        : `Done: ${result.written} of ${result.checked} open tickets got a due date.`,
    );
  } catch (err) {
    console.error(
      `Stopped: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
