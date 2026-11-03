import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuditEventsQueryDto } from './audit-events-query.dto';

// Spec 0021, AC-10: comma lists, exact values, limits and 400 messages that name the problem.

const parse = async (query: Record<string, unknown>) => {
  const dto = plainToInstance(AuditEventsQueryDto, query);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return {
    dto,
    messages: errors.flatMap((e) => Object.values(e.constraints ?? {})),
  };
};

describe('AuditEventsQueryDto (spec 0021, AC-10)', () => {
  it('splits, trims, drops empty items and removes duplicates', async () => {
    const { dto, messages } = await parse({
      categories: ' CHECKLIST,,COSTS, CHECKLIST ',
      types: 'LOCKED,LOCKED',
    });
    expect(messages).toEqual([]);
    expect(dto.categories).toEqual(['CHECKLIST', 'COSTS']);
    expect(dto.types).toEqual(['LOCKED']);
  });

  it('accepts a repeated parameter as well as a comma list', async () => {
    const { dto } = await parse({ types: ['LOCKED', 'UNLOCK,CREATED'] });
    expect(dto.types).toEqual(['LOCKED', 'UNLOCK', 'CREATED']);
  });

  it('ignores an empty list', async () => {
    const { dto, messages } = await parse({ categories: ' , ' });
    expect(messages).toEqual([]);
    expect(dto.categories).toEqual([]);
  });

  it.each([
    [{ categories: 'checklist' }, 'categories must be one of'],
    [{ types: 'NOPE' }, 'types must be one of the event types'],
    [{ type: 'NOPE' }, 'type must be one of the event types'],
    [{ actorRole: 'admin' }, 'actorRole must be one of'],
  ])('answers 400 for an unknown or wrongly cased value %j', async (q, msg) => {
    const { messages } = await parse(q);
    expect(messages.join(' ')).toContain(msg);
  });

  it('refuses more than 30 types', async () => {
    // 31 distinct values, so only the size rule and the value rule can fail
    const many = Array.from({ length: 31 }, (_, i) => `T${i}`).join(',');
    const { messages } = await parse({ types: many });
    expect(messages).toContain('types accepts at most 30 values');
  });

  it('accepts reserved types (filters take them before anything writes them)', async () => {
    const { messages } = await parse({
      types: 'STATUS_OVERRIDE,TRANSFER_REQUESTED',
      actorRole: 'SYSTEM',
    });
    expect(messages).toEqual([]);
  });
});
