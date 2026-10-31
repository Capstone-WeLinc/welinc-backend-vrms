import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateRepairStatusDto } from './update-repair-status.dto';
import { UnlockTicketDto } from './unlock-ticket.dto';
import { UpdateCostsDto } from './update-costs.dto';

// Spec 0014, AC-12: lastUpdatedAt is required on the status, unlock and costs bodies, and a
// malformed value is a 400 from validation, not a 409 from the stale check.

const STAMP = '2026-10-31T10:00:00.000Z';

function failing<T extends object>(
  cls: new () => T,
  body: Record<string, unknown>,
) {
  return validateSync(plainToInstance(cls, body), { whitelist: true }).map(
    (e) => e.property,
  );
}

const bodies = {
  status: {
    cls: UpdateRepairStatusDto,
    valid: { status: 'IN_PROGRESS' },
  },
  unlock: {
    cls: UnlockTicketDto,
    valid: { unlockReason: 'Fix the costs' },
  },
  costs: {
    cls: UpdateCostsDto,
    valid: { isLumpSum: true, partsCost: 10, laborCost: 5 },
  },
};

describe.each(Object.entries(bodies))('%s body lastUpdatedAt', (_name, b) => {
  // covers: AC-12
  it('accepts an ISO 8601 stamp', () => {
    expect(failing(b.cls, { ...b.valid, lastUpdatedAt: STAMP })).toEqual([]);
  });

  it('rejects a missing value', () => {
    expect(failing(b.cls, b.valid)).toContain('lastUpdatedAt');
  });

  it.each(['yesterday', '', '12/31/2026', 12345])(
    'rejects %p as malformed',
    (value) => {
      expect(failing(b.cls, { ...b.valid, lastUpdatedAt: value })).toContain(
        'lastUpdatedAt',
      );
    },
  );
});
