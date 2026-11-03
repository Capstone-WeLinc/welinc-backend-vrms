import { RepairStatus } from '@prisma/client';
import { OPEN_STATUSES } from './ticket-statuses';

// Feature 57 (mechanic workload): the one rule for how busy a mechanic is. The Users page, its
// filter and the assignment picker all read it, so "Occupied" means the same thing everywhere.

export type Workload = {
  /** Open tickets the person is assigned to. */
  total: number;
  /** Every open status as a key, zeros included. */
  byStatus: Record<string, number>;
  /** At least one of those tickets is In Progress. */
  occupied: boolean;
};

/** True when any of the statuses is In Progress. */
export function isOccupied(statuses: readonly RepairStatus[]) {
  return statuses.includes(RepairStatus.IN_PROGRESS);
}

/** The workload behind a list of open ticket statuses, one entry per assignment. */
export function workloadOf(statuses: readonly RepairStatus[]): Workload {
  const byStatus = Object.fromEntries(
    OPEN_STATUSES.map((s) => [s, 0]),
  ) as Record<string, number>;
  let total = 0;
  for (const status of statuses) {
    if (!(status in byStatus)) continue;
    byStatus[status] += 1;
    total += 1;
  }
  return { total, byStatus, occupied: isOccupied(statuses) };
}

/** Open statuses in workflow order, for sorting a person's open tickets. */
export function openStatusRank(status: RepairStatus) {
  const rank = OPEN_STATUSES.indexOf(status);
  return rank === -1 ? OPEN_STATUSES.length : rank;
}
