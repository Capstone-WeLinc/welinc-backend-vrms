import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ERASED_NAME,
  ERASURE_COPY_COLUMNS,
  scrubChanges,
} from './erasure-rewrite';

// covers: suite spec 0012 AC-25 (every name or email copy beside a user id is in the rewrite
// list, and audit `changes` lose only exact matches)

/** Each table's columns, read from the Prisma schema (`@map` names, else the field name). */
function tablesOf(schema: string): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const block of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const body = block[2];
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? block[1];
    const columns: string[] = [];
    for (const line of body.split('\n')) {
      const field = /^\s+(\w+)\s+\w/.exec(line);
      if (!field || line.trim().startsWith('@@')) continue;
      columns.push(/@map\("([^"]+)"\)/.exec(line)?.[1] ?? field[1]);
    }
    tables.set(table, columns);
  }
  return tables;
}

describe('ERASURE_COPY_COLUMNS', () => {
  const schema = readFileSync(
    join(__dirname, '../../../../prisma/schema.prisma'),
    'utf8',
  );
  const tables = tablesOf(schema);

  it('lists every <who>_name and <who>_email beside a <who>_user_id', () => {
    const missing: string[] = [];
    for (const [table, columns] of tables) {
      for (const column of columns) {
        const copy = /^(.+)_(name|email)$/.exec(column);
        if (!copy) continue;
        const idColumn = `${copy[1]}_user_id`;
        if (!columns.includes(idColumn)) continue;
        const listed = ERASURE_COPY_COLUMNS.some(
          (entry) =>
            entry.table === table &&
            entry.idColumn === idColumn &&
            (entry.nameColumn === column || entry.emailColumn === column),
        );
        if (!listed) missing.push(`${table}.${column}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('names only columns that exist', () => {
    for (const entry of ERASURE_COPY_COLUMNS) {
      const columns = tables.get(entry.table);
      expect(columns).toBeDefined();
      for (const column of [
        entry.idColumn,
        entry.nameColumn,
        entry.emailColumn,
      ]) {
        if (column) expect(columns).toContain(column);
      }
    }
  });

  it('covers the mechanics row itself', () => {
    expect(ERASURE_COPY_COLUMNS).toContainEqual({
      table: 'mechanics',
      idColumn: 'auth_user_id',
      nameColumn: 'name',
      emailColumn: 'email',
    });
  });
});

describe('scrubChanges', () => {
  it('replaces exact name and email matches, at any depth, and keeps the rest', () => {
    const changes = [
      { field: 'mechanic', before: 'Ana Cruz', after: null },
      {
        field: 'mechanics',
        before: ['Ana Cruz', 'Ben Reyes'],
        after: ['Ben Reyes'],
      },
      { field: 'notes', before: 'Ana Cruz said hi', after: 'ANA@welinc.com' },
    ];
    expect(scrubChanges(changes, 'Ana Cruz', 'ana@welinc.com')).toEqual([
      { field: 'mechanic', before: ERASED_NAME, after: null },
      {
        field: 'mechanics',
        before: [ERASED_NAME, 'Ben Reyes'],
        after: ['Ben Reyes'],
      },
      { field: 'notes', before: 'Ana Cruz said hi', after: null },
    ]);
  });

  it('answers the same value when nothing matches, so the row is not rewritten', () => {
    const changes = [{ field: 'priority', before: 'LOW', after: 'HIGH' }];
    expect(scrubChanges(changes, 'Ana Cruz', null)).toBe(changes);
  });
});
