// First, before AppModule loads: the test environment values (they override any real env), so the
// boot check passes with no .env, no database and no network (VRMS spec 0026, AC-9).
import '../config/test-env.setup';
import { NestFactory } from '@nestjs/core';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from '../app.module';
import { buildDocument } from './document';

/**
 * `npm run openapi` writes docs/openapi.json from the built app; `npm run openapi:check` (`--check`)
 * exits 1 when the committed file differs. No init(), no listen(): no module init hook runs, so
 * nothing connects to the database or the network.
 */
const TARGET = resolve('docs', 'openapi.json');
const HINT = 'run npm run openapi and commit docs/openapi.json';

async function main(): Promise<number> {
  const app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  const text = `${JSON.stringify(buildDocument(app), null, 2)}\n`;
  await app.close();

  if (!process.argv.includes('--check')) {
    writeFileSync(TARGET, text);
    console.log(`Wrote ${TARGET}`);
    return 0;
  }

  let committed: string | null = null;
  try {
    committed = readFileSync(TARGET, 'utf8');
  } catch {
    committed = null;
  }
  if (committed === text) {
    console.log('docs/openapi.json matches the code');
    return 0;
  }
  console.error(
    committed === null
      ? `docs/openapi.json is missing: ${HINT}`
      : `docs/openapi.json is out of date: ${HINT}`,
  );
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  },
);
