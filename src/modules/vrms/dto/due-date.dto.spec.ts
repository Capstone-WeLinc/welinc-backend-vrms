import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChangeDueDateDto, ResetDueDateDto } from './due-date.dto';

// Spec 0030, AC-8 and AC-9: the body rules that need no database.

const base = {
  lastUpdatedAt: '2026-11-27T06:00:00.000Z',
  dueAt: '2026-12-01T09:00:00+08:00',
  reason: 'Parts arrive Monday',
};

async function change(overrides: Record<string, unknown>) {
  const dto = plainToInstance(ChangeDueDateDto, { ...base, ...overrides });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

async function reset(overrides: Record<string, unknown>) {
  const dto = plainToInstance(ResetDueDateDto, {
    lastUpdatedAt: base.lastUpdatedAt,
    reason: base.reason,
    ...overrides,
  });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
}

describe('ChangeDueDateDto (AC-8)', () => {
  it('accepts a date with an offset, or with Z', async () => {
    expect((await change({})).errors).toHaveLength(0);
    expect(
      (await change({ dueAt: '2026-12-01T01:00:00.000Z' })).errors,
    ).toHaveLength(0);
  });

  it('refuses a date with no timezone offset, so the browser never guesses the moment', async () => {
    const { errors } = await change({ dueAt: '2026-12-01T09:00:00' });
    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {}).join(' ')).toMatch(
      /timezone offset/,
    );
  });

  it('refuses a missing or junk date', async () => {
    expect((await change({ dueAt: undefined })).errors.length).toBeGreaterThan(
      0,
    );
    expect((await change({ dueAt: 'tomorrow' })).errors.length).toBeGreaterThan(
      0,
    );
    expect(
      (await change({ dueAt: 1764579600000 })).errors.length,
    ).toBeGreaterThan(0);
  });

  it('trims the reason and needs 5 to 500 characters', async () => {
    const short = await change({ reason: '  abc  ' });
    expect(short.errors).toHaveLength(1);
    expect(short.dto.reason).toBe('abc');
    expect((await change({ reason: '  12345  ' })).errors).toHaveLength(0);
    expect((await change({ reason: 'x'.repeat(500) })).errors).toHaveLength(0);
    expect((await change({ reason: 'x'.repeat(501) })).errors).toHaveLength(1);
    expect((await change({ reason: undefined })).errors.length).toBeGreaterThan(
      0,
    );
  });

  it('needs the stale check stamp as an ISO date (AC-15)', async () => {
    expect(
      (await change({ lastUpdatedAt: undefined })).errors.length,
    ).toBeGreaterThan(0);
    expect(
      (await change({ lastUpdatedAt: 'yesterday' })).errors.length,
    ).toBeGreaterThan(0);
  });

  it('rejects fields it does not know, such as a source', async () => {
    expect(
      (await change({ dueAtSource: 'PRIORITY' })).errors.length,
    ).toBeGreaterThan(0);
  });
});

describe('ResetDueDateDto (AC-9)', () => {
  it('needs no date, only a reason and the stale stamp', async () => {
    expect((await reset({})).errors).toHaveLength(0);
  });

  it('needs a reason of 5 to 500 characters, trimmed', async () => {
    expect((await reset({ reason: '   ' })).errors.length).toBeGreaterThan(0);
    expect((await reset({ reason: 'four' })).errors).toHaveLength(1);
    expect((await reset({ reason: 'x'.repeat(501) })).errors).toHaveLength(1);
  });

  it('does not take a date, so a reset cannot smuggle one in', async () => {
    expect(
      (await reset({ dueAt: '2026-12-01T09:00:00+08:00' })).errors.length,
    ).toBeGreaterThan(0);
  });
});
