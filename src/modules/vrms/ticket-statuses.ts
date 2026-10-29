import { RepairStatus } from '@prisma/client';

// Spec 0010, AC-4a: the one definition of open and finished tickets. Every query reads these,
// never a list of its own.

/** CLOSED and CANCELLED: the ticket is over, and locked until an Admin unlocks it. */
export const FINISHED_STATUSES: RepairStatus[] = [
  RepairStatus.CLOSED,
  RepairStatus.CANCELLED,
];

/** Every status except the finished ones. */
export const OPEN_STATUSES: RepairStatus[] = Object.values(RepairStatus).filter(
  (s) => !FINISHED_STATUSES.includes(s),
);

export function isFinished(status: RepairStatus) {
  return FINISHED_STATUSES.includes(status);
}

/** Display labels, for error messages. The web app has its own copy in statusLabels.ts. */
export const STATUS_LABELS: Record<RepairStatus, string> = {
  OPEN: 'Open',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  ON_HOLD: 'On hold',
  FOR_VERIFICATION: 'For verification',
  OUTSOURCED: 'Outsourced',
  PENDING_APPROVAL: 'Pending approval',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};
