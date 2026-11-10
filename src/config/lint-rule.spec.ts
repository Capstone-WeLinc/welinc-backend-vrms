import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// covers: spec 0010 AC-11 (lint fails on a process.env read outside the env files)

const ROOT = join(__dirname, '..', '..');
const ERROR = 2;

/** Severity of `no-restricted-properties` per path, asked of the real eslint.config in a child process
 * (Jest cannot import the ESM flat config itself). 0 means the rule is off or the path is ignored. */
function severities(paths: string[]): Record<string, number> {
  const script = `
    const { ESLint } = require('eslint');
    (async () => {
      const eslint = new ESLint();
      const out = {};
      for (const p of ${JSON.stringify(paths)}) {
        const config = await eslint.calculateConfigForFile(p);
        const rule = config && config.rules && config.rules['no-restricted-properties'];
        out[p] = rule ? rule[0] : 0;
      }
      console.log(JSON.stringify(out));
    })();`;
  const stdout = execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim().split('\n').pop() as string) as Record<
    string,
    number
  >;
}

describe('the process.env lint rule (AC-11)', () => {
  const guarded = [
    'src/app.module.ts',
    'src/main.ts',
    'src/modules/vrms/repairs.service.ts',
    'src/shared/prisma.service.ts',
  ];
  const exempt = [
    'src/config/env.ts',
    'src/config/check-env.ts',
    'src/config/env.spec.ts',
    'src/app.controller.spec.ts',
    'prisma/seed.ts',
    'prisma.config.ts',
    'scripts/anything.ts',
  ];
  let result: Record<string, number>;

  beforeAll(() => {
    result = severities([...guarded, ...exempt]);
  }, 60_000);

  it.each(guarded)('is an error in %s', (path) => {
    expect(result[path]).toBe(ERROR);
  });

  it.each(exempt)('lets %s read process.env', (path) => {
    expect(result[path]).not.toBe(ERROR);
  });
});
