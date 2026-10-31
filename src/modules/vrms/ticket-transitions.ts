import { RepairStatus } from '@prisma/client';
import { OPEN_STATUSES, STATUS_LABELS } from './ticket-statuses';

// Spec 0014, AC-1: the one definition of ticket status moves. Every status write after create
// goes through applyStatusMove with one of these moves; nothing else writes repairStatus.

/** Who switches a move on: the status endpoint, or the later feature that owns it. */
export type MoveTrigger =
  | 'status'
  | 'assignment'
  | 'hold'
  | 'outsource'
  | 'approval';
/** The right a status endpoint move needs (AC-6). Owner features check their own rights. */
export type MoveRight = 'work' | 'verify' | 'administer';
export type MoveNeed = 'resolutions' | 'remarks' | 'cancellationReason';
export type MoveKind = 'forward' | 'back' | 'cancel';

export type TicketMove = {
  id: `M${number}`;
  from: readonly RepairStatus[];
  to: RepairStatus;
  trigger: MoveTrigger;
  /** Status trigger only. */
  right?: MoveRight;
  needs?: readonly MoveNeed[];
  kind: MoveKind;
  /** Status trigger only: the button the web app shows. */
  label?: string;
};

const S = RepairStatus;

export const TICKET_MOVES: readonly TicketMove[] = [
  {
    id: 'M1',
    from: [S.OPEN],
    to: S.ASSIGNED,
    trigger: 'assignment',
    kind: 'forward',
  },
  {
    id: 'M2',
    from: [S.ASSIGNED],
    to: S.OPEN,
    trigger: 'assignment',
    kind: 'back',
  },
  {
    id: 'M3',
    from: [S.ASSIGNED],
    to: S.IN_PROGRESS,
    trigger: 'status',
    right: 'work',
    kind: 'forward',
    label: 'Start work',
  },
  {
    id: 'M4',
    from: [S.IN_PROGRESS],
    to: S.FOR_VERIFICATION,
    trigger: 'status',
    right: 'work',
    needs: ['resolutions'],
    kind: 'forward',
    label: 'Send for verification',
  },
  {
    id: 'M5',
    from: [S.FOR_VERIFICATION],
    to: S.CLOSED,
    trigger: 'status',
    right: 'verify',
    kind: 'forward',
    label: 'Verify and close',
  },
  {
    id: 'M6',
    from: [S.FOR_VERIFICATION],
    to: S.IN_PROGRESS,
    trigger: 'status',
    right: 'verify',
    needs: ['remarks'],
    kind: 'back',
    label: 'Send back',
  },
  {
    id: 'M7',
    from: [S.IN_PROGRESS],
    to: S.ON_HOLD,
    trigger: 'hold',
    kind: 'forward',
  },
  {
    id: 'M8',
    from: [S.ON_HOLD],
    to: S.IN_PROGRESS,
    trigger: 'hold',
    kind: 'back',
  },
  {
    id: 'M9',
    from: [S.OPEN, S.ASSIGNED, S.IN_PROGRESS, S.ON_HOLD],
    to: S.OUTSOURCED,
    trigger: 'outsource',
    kind: 'forward',
  },
  {
    id: 'M10',
    from: [S.OUTSOURCED],
    to: S.PENDING_APPROVAL,
    trigger: 'outsource',
    kind: 'forward',
  },
  {
    id: 'M11',
    from: [S.OUTSOURCED],
    to: S.CLOSED,
    trigger: 'outsource',
    kind: 'forward',
  },
  {
    id: 'M12',
    from: [S.PENDING_APPROVAL],
    to: S.CLOSED,
    trigger: 'approval',
    kind: 'forward',
  },
  {
    id: 'M13',
    from: [S.PENDING_APPROVAL],
    to: S.OUTSOURCED,
    trigger: 'approval',
    kind: 'back',
  },
  {
    id: 'M14',
    from: OPEN_STATUSES,
    to: S.CANCELLED,
    trigger: 'status',
    right: 'administer',
    needs: ['cancellationReason'],
    kind: 'cancel',
    label: 'Cancel ticket',
  },
];

/** The one move from `from` to `to`, of any trigger. */
export function findMove(
  from: RepairStatus,
  to: RepairStatus,
): TicketMove | undefined {
  return TICKET_MOVES.find((m) => m.to === to && m.from.includes(from));
}

/** The moves the status endpoint may make from `from`, in table order. */
export function statusMovesFrom(from: RepairStatus): TicketMove[] {
  return TICKET_MOVES.filter(
    (m) => m.trigger === 'status' && m.from.includes(from),
  );
}

/** What the owner feature's action is called, for a move the status endpoint may not make. */
const OWNER_ACTION: Record<
  Exclude<MoveTrigger, 'status'>,
  (to: RepairStatus) => string
> = {
  assignment: (to) =>
    to === S.ASSIGNED
      ? 'when a mechanic is assigned'
      : 'when its last mechanic is removed',
  hold: (to) =>
    to === S.ON_HOLD ? 'when a hold is filed' : 'when its hold ends',
  outsource: (to) =>
    to === S.OUTSOURCED
      ? 'when it is sent to an outside shop'
      : "when the outside shop's receipt and cost are in",
  approval: (to) =>
    to === S.CLOSED
      ? 'when its outside cost is approved'
      : 'when its outside cost is rejected',
};

/** The message of a 400 INVALID_TRANSITION from the status endpoint (AC-3). */
export function invalidMoveMessage(
  from: RepairStatus,
  to: RepairStatus,
): string {
  const move = findMove(from, to);
  if (move && move.trigger !== 'status') {
    return `A ticket goes ${STATUS_LABELS[to]} ${OWNER_ACTION[move.trigger](to)}, not from here.`;
  }
  if (from === to) return `This ticket is already ${STATUS_LABELS[to]}.`;
  return `Can't move a ticket from '${STATUS_LABELS[from]}' to '${STATUS_LABELS[to]}'.`;
}
