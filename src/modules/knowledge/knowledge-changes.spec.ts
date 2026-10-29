import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  changeRows,
  diffFields,
  duplicateConflict,
  hoursText,
  isUniqueViolation,
  loadedAt,
  nameKey,
  notFound,
  numberedList,
  staleConflict,
} from './knowledge-changes';
import type { JwtUser } from './knowledge-actor';

// Spec 0007 AC-38 / AC-5 / AC-20 in the spec 0010 change log shape.

const admin: JwtUser = {
  sub: 'user-1',
  email: 'admin@example.com',
  name: 'Ana Admin',
  system: 'VRMS',
  roles: [{ role: 'ADMIN', system: 'VRMS' }],
};

describe('diffFields', () => {
  it('lists only the fields whose value differs', () => {
    expect(
      diffFields({ name: 'A', steps: '1. x' }, { name: 'B', steps: '1. x' }),
    ).toEqual([{ field: 'name', before: 'A', after: 'B' }]);
  });

  it('returns nothing when nothing changed', () => {
    expect(
      diffFields({ name: 'A', parts: null }, { name: 'A', parts: null }),
    ).toEqual([]);
  });

  it('records a cleared field as after null', () => {
    expect(diffFields({ parts: '1. Pad' }, { parts: null })).toEqual([
      { field: 'parts', before: '1. Pad', after: null },
    ]);
  });
});

describe('text helpers', () => {
  it('numbers steps one per line', () => {
    expect(numberedList(['Lift', 'Remove'])).toBe('1. Lift\n2. Remove');
    expect(numberedList([])).toBe('');
  });

  it('renders hours as plain text and null as null', () => {
    expect(hoursText(null)).toBeNull();
    expect(hoursText(undefined)).toBeNull();
    expect(hoursText(2.5)).toBe('2.5');
    expect(hoursText(new Prisma.Decimal('3.50'))).toBe('3.5');
    expect(hoursText(0)).toBe('0');
  });

  it('makes the name key case and space insensitive (AC-5)', () => {
    expect(nameKey('  Brake Pads ')).toBe(nameKey('brake pads'));
  });
});

describe('changeRows', () => {
  it('writes no row when nothing changed', () => {
    expect(changeRows(admin, 'ENTRY_UPDATED', { entryId: 'e1' }, [])).toEqual(
      [],
    );
  });

  it('writes one row per event with the actor from the token (AC-38)', () => {
    const changes = [
      { field: 'name', before: 'A', after: 'B' },
      { field: 'steps', before: '1. a', after: '1. b' },
    ];
    const rows = changeRows(admin, 'ENTRY_UPDATED', { entryId: 'e1' }, changes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entryId: 'e1',
      categoryId: null,
      actorUserId: 'user-1',
      actorName: 'Ana Admin',
      actorRole: 'ADMIN',
      action: 'ENTRY_UPDATED',
      changes,
    });
  });

  it('points a category event at the category only', () => {
    const [row] = changeRows(admin, 'CATEGORY_STATUS', { categoryId: 'c1' }, [
      { field: 'status', before: 'ACTIVE', after: 'DISABLED' },
    ]);
    expect(row.entryId).toBeNull();
    expect(row.categoryId).toBe('c1');
  });
});

describe('conflicts and errors', () => {
  it('tells STALE and DUPLICATE_NAME apart in the 409 body (AC-20)', () => {
    const stale = staleConflict('Reload');
    const dup = duplicateConflict('Taken');
    expect(stale).toBeInstanceOf(ConflictException);
    expect(stale.getResponse()).toMatchObject({
      statusCode: 409,
      code: 'STALE',
      message: 'Reload',
    });
    expect(dup.getResponse()).toMatchObject({
      statusCode: 409,
      code: 'DUPLICATE_NAME',
      message: 'Taken',
    });
  });

  it('answers not found with only the kind of thing', () => {
    const err = notFound('entry');
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe("This entry isn't available.");
  });

  it('recognises only a Prisma P2002 as a unique violation', () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const other = new Prisma.PrismaClientKnownRequestError('x', {
      code: 'P2025',
      clientVersion: 'test',
    });
    expect(isUniqueViolation(p2002)).toBe(true);
    expect(isUniqueViolation(other)).toBe(false);
    expect(isUniqueViolation(new Error('P2002'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe('loadedAt', () => {
  it('covers the one millisecond the client saw, microseconds included', () => {
    const { gte, lt } = loadedAt('2026-10-29T08:00:00.123Z');
    expect(gte.toISOString()).toBe('2026-10-29T08:00:00.123Z');
    expect(lt.toISOString()).toBe('2026-10-29T08:00:00.124Z');
    const withMicros = new Date('2026-10-29T08:00:00.123Z').getTime() + 0.456;
    expect(withMicros >= gte.getTime() && withMicros < lt.getTime()).toBe(true);
  });
});
