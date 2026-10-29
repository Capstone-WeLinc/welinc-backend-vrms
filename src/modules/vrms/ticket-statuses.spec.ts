import { RepairStatus } from '@prisma/client';
import {
  FINISHED_STATUSES,
  OPEN_STATUSES,
  STATUS_LABELS,
  isFinished,
} from './ticket-statuses';

// Spec 0010, AC-4a: the one definition of open and finished tickets.

describe('ticket statuses', () => {
  it('finished means closed or cancelled and nothing else', () => {
    expect([...FINISHED_STATUSES].sort()).toEqual(['CANCELLED', 'CLOSED']);
  });

  it('open and finished together cover every status once (AC-4a)', () => {
    const all = Object.values(RepairStatus);
    expect([...OPEN_STATUSES, ...FINISHED_STATUSES].sort()).toEqual(
      [...all].sort(),
    );
    expect(OPEN_STATUSES.filter((s) => FINISHED_STATUSES.includes(s))).toEqual(
      [],
    );
  });

  it('keeps the long running states open, ON_HOLD and OUTSOURCED included (AC-4a)', () => {
    expect(OPEN_STATUSES).toEqual(
      expect.arrayContaining(['ON_HOLD', 'OUTSOURCED', 'PENDING_APPROVAL']),
    );
  });

  it('isFinished agrees with the lists for every status', () => {
    for (const status of Object.values(RepairStatus)) {
      expect(isFinished(status)).toBe(!OPEN_STATUSES.includes(status));
    }
  });

  it('has a readable label for every status', () => {
    for (const status of Object.values(RepairStatus)) {
      expect(STATUS_LABELS[status]).toMatch(/^[A-Z][a-z ]+$/);
    }
  });

  it('does not carry the retired v1 statuses (AC-2)', () => {
    expect(Object.values(RepairStatus)).not.toContain('PENDING');
    expect(Object.values(RepairStatus)).not.toContain('COMPLETED');
  });
});
