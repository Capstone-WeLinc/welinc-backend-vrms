import { RepairStatus } from '@prisma/client';
import { FINISHED_STATUSES, OPEN_STATUSES } from './ticket-statuses';
import {
  findMove,
  invalidMoveMessage,
  statusMovesFrom,
  TICKET_MOVES,
} from './ticket-transitions';

// Spec 0014, AC-1 and AC-2: the transition table itself.

describe('TICKET_MOVES (AC-1)', () => {
  it('holds exactly the 14 moves M1 to M14, in order', () => {
    expect(TICKET_MOVES.map((m) => m.id)).toEqual(
      Array.from({ length: 14 }, (_, i) => `M${i + 1}`),
    );
  });

  it('gives every status move a right and a label, and no other move either', () => {
    for (const m of TICKET_MOVES) {
      const isStatus = m.trigger === 'status';
      expect([m.id, !!m.right, !!m.label]).toEqual([m.id, isStatus, isStatus]);
    }
  });

  it('puts the status endpoint on M3 to M6 and M14 only', () => {
    expect(
      TICKET_MOVES.filter((m) => m.trigger === 'status').map((m) => m.id),
    ).toEqual(['M3', 'M4', 'M5', 'M6', 'M14']);
  });

  it('has at most one move between any two statuses, so findMove is exact', () => {
    const statuses = Object.values(RepairStatus);
    for (const from of statuses) {
      for (const to of statuses) {
        const matches = TICKET_MOVES.filter(
          (m) => m.to === to && m.from.includes(from),
        );
        expect(matches.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never starts a move from a finished status', () => {
    for (const m of TICKET_MOVES) {
      expect(m.from.some((s) => FINISHED_STATUSES.includes(s))).toBe(false);
    }
  });
});

describe('every open status can move on (AC-2)', () => {
  it.each(OPEN_STATUSES)('%s has at least one move out', (status) => {
    expect(TICKET_MOVES.some((m) => m.from.includes(status))).toBe(true);
  });

  it.each(FINISHED_STATUSES)('%s has no move out', (status) => {
    expect(TICKET_MOVES.some((m) => m.from.includes(status))).toBe(false);
  });

  it('cancels from all seven open statuses', () => {
    for (const status of OPEN_STATUSES) {
      expect(findMove(status, RepairStatus.CANCELLED)?.id).toBe('M14');
    }
  });
});

describe('lookups and messages (AC-3)', () => {
  it('lists the status endpoint moves from For verification: verify, send back, cancel', () => {
    expect(
      statusMovesFrom(RepairStatus.FOR_VERIFICATION).map((m) => m.id),
    ).toEqual(['M5', 'M6', 'M14']);
  });

  it('names both statuses for a move outside the table', () => {
    expect(
      invalidMoveMessage(RepairStatus.CLOSED, RepairStatus.IN_PROGRESS),
    ).toBe("Can't move a ticket from 'Closed' to 'In progress'.");
  });

  it('names the owning action for a move a later feature makes', () => {
    expect(
      invalidMoveMessage(RepairStatus.IN_PROGRESS, RepairStatus.ON_HOLD),
    ).toBe('A ticket goes On hold when a hold is filed, not from here.');
  });
});
