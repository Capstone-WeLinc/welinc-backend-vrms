import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { HistoryQueryDto } from './history-query.dto';

// Spec 0010, AC-16: history takes the finished statuses only. A retired status is a 400.

function problems(query: Record<string, unknown>) {
  const dto = plainToInstance(HistoryQueryDto, query);
  return validateSync(dto, { whitelist: true }).map((e) => e.property);
}

describe('HistoryQueryDto', () => {
  it('accepts an empty query', () => {
    expect(problems({})).toEqual([]);
  });

  it.each(['CLOSED', 'CANCELLED'])('accepts status=%s', (status) => {
    expect(problems({ status })).toEqual([]);
  });

  it.each(['COMPLETED', 'PENDING', 'IN_PROGRESS', 'ON_HOLD', 'closed'])(
    'rejects status=%s (AC-16)',
    (status) => {
      expect(problems({ status })).toEqual(['status']);
    },
  );

  it('turns page and limit strings into numbers and rejects zero or junk', () => {
    const dto = plainToInstance(HistoryQueryDto, { page: '2', limit: '500' });
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(500);
    expect(problems({ page: '0' })).toEqual(['page']);
    expect(problems({ limit: 'abc' })).toEqual(['limit']);
    expect(problems({ page: '1.5' })).toEqual(['page']);
  });

  it('has no upper cap on limit (the dashboard asks for every row)', () => {
    expect(problems({ limit: '1000000' })).toEqual([]);
  });

  it('wants ISO dates for from and to', () => {
    expect(
      problems({ from: '2026-10-01', to: '2026-10-29T00:00:00Z' }),
    ).toEqual([]);
    expect(problems({ from: 'yesterday' })).toEqual(['from']);
    expect(problems({ to: '2026-02-31' })).toEqual(['to']);
  });

  it('wants a UUID for garageId and caps search at 100 characters', () => {
    expect(problems({ garageId: 'not-a-uuid' })).toEqual(['garageId']);
    expect(
      problems({ garageId: '00000000-0000-4000-8000-000000000001' }),
    ).toEqual([]);
    expect(problems({ search: 'a'.repeat(100) })).toEqual([]);
    expect(problems({ search: 'a'.repeat(101) })).toEqual(['search']);
  });
});
