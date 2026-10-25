import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JwtUser } from './knowledge-actor';

// Spec 0007, AC-38 and Jira WL-704: every write that changes an entry or a category writes
// KnowledgeEntryChange rows, one per changed field, in the same transaction.

export type ChangeAction =
  | 'ENTRY_CREATED'
  | 'ENTRY_UPDATED'
  | 'ENTRY_STATUS'
  | 'CATEGORY_CREATED'
  | 'CATEGORY_UPDATED'
  | 'CATEGORY_STATUS';

export type FieldChange = {
  fieldName: string;
  previousValue: string | null;
  newValue: string | null;
};

/** The entry fields the change log compares, as display strings. */
export type EntrySnapshot = {
  name: string;
  category: string;
  suggestedPriority: string;
  estimatedHours: string | null;
  symptoms: string;
  descriptionTemplate: string | null;
  safetyNotes: string | null;
  steps: string;
  parts: string | null;
};

/** One row per field whose value differs. */
export function diffFields<T extends Record<string, string | null>>(
  before: T,
  after: T,
): FieldChange[] {
  return (Object.keys(after) as (keyof T & string)[])
    .filter((key) => (before[key] ?? null) !== (after[key] ?? null))
    .map((key) => ({
      fieldName: key,
      previousValue: before[key] ?? null,
      newValue: after[key] ?? null,
    }));
}

/** Steps and parts read "1. Lift the vehicle" one per line. */
export function numberedList(items: string[]) {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

export function hoursText(value: Prisma.Decimal | number | null | undefined) {
  return value == null ? null : String(Number(value));
}

export function changeRows(
  user: JwtUser,
  action: ChangeAction,
  target: { entryId?: string; categoryId?: string },
  changes: FieldChange[],
): Prisma.KnowledgeEntryChangeCreateManyInput[] {
  return changes.map((change) => ({
    entryId: target.entryId ?? null,
    categoryId: target.categoryId ?? null,
    userId: user.sub,
    email: user.email,
    action,
    ...change,
  }));
}

/** trim(lower(name)), the unique key for entries and categories (AC-5). */
export function nameKey(name: string) {
  return name.trim().toLowerCase();
}

/**
 * A 409 the client can tell apart: STALE reloads the form, DUPLICATE_NAME shows under Name (AC-20).
 */
export function staleConflict(message: string) {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'STALE',
    message,
  });
}

export function duplicateConflict(message: string) {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'DUPLICATE_NAME',
    message,
  });
}

/** Matches the updatedAt the client loaded; Postgres keeps microseconds, the client sees milliseconds. */
export function loadedAt(lastUpdatedAt: string) {
  const t = new Date(lastUpdatedAt);
  return { gte: t, lt: new Date(t.getTime() + 1) };
}

export function isUniqueViolation(err: unknown) {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

export function notFound(what: string) {
  return new NotFoundException(`This ${what} isn't available.`);
}
