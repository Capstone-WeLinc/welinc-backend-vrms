import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import type { Env } from '../src/config/env';
import { describeLinkPlan } from '../src/modules/integrations/fleet/fleet-link-plan';
import { FleetLinkService } from '../src/modules/integrations/fleet/fleet-link.service';

// Spec 0029 (child 0001), AC-1: `npm run fleet:link [-- --confirm]`. Links VRMS's trucks and
// garages to VMMS by plate and name. Without --confirm it only prints the plan. Two VRMS rows
// claiming one VMMS record stop it (exit 1) with nothing changed. With --confirm it links the
// matches, archives the rest (their tickets stay) and adds what VMMS has and VRMS lacks. Run it
// once locally and once on staging, before the sync is switched on. Safe to run again.

async function main() {
  const confirm = process.argv.includes('--confirm');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const config = app.get<ConfigService<Env, true>>(ConfigService);
    if (
      confirm &&
      config.get('SENTRY_ENVIRONMENT', { infer: true }) === 'production'
    ) {
      console.error('fleet:link --confirm is refused in production.');
      process.exitCode = 1;
      return;
    }
    const outcome = await app.get(FleetLinkService).run(confirm);
    for (const line of describeLinkPlan(outcome.plan)) console.log(line);
    if (outcome.kind === 'double_claim') {
      console.error('Stopped: fix the rows above (one VMMS record each), then run again.');
      process.exitCode = 1;
    } else if (outcome.kind === 'planned') {
      console.log('Plan only. Run again with --confirm to apply it.');
    } else {
      for (const clash of outcome.clashes) console.warn(clash);
      console.log('Applied.');
    }
  } catch (err) {
    console.error(`Stopped: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
