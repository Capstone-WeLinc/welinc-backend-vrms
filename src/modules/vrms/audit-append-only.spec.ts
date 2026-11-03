import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// Spec 0021, AC-14: no code path changes or deletes an audit row. A best effort grep over src/
// (it can't see raw SQL); the database trigger from AC-13 is the real protection.

const SRC = join(__dirname, '..', '..');
const FORBIDDEN =
  /\.auditLog\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\s*\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('audit_logs is append only in code (spec 0021, AC-14)', () => {
  it('no file under src/ updates, deletes or upserts an audit row', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      FORBIDDEN.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });

  it('the pattern catches the calls it is meant to catch', () => {
    expect(FORBIDDEN.test('await tx.auditLog.deleteMany({})')).toBe(true);
    expect(FORBIDDEN.test('this.prisma.auditLog.update({')).toBe(true);
    expect(FORBIDDEN.test('tx.auditLog.create({')).toBe(false);
  });
});
