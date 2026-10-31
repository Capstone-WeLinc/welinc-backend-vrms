import { accessibleBy } from '@casl/prisma';
import type { Prisma } from '@prisma/client';
import type { AppAbility } from '../../auth/permissions/ability.factory';

/** The tickets the caller may read, as a where; null when they may read none (spec 0011, AC-10). */
export function readableTickets(
  ability: AppAbility,
): Prisma.RepairTicketWhereInput | null {
  // accessibleBy's no access marker fails a query, so answer empty before reaching Prisma
  if (!ability.can('read', 'RepairTicket')) return null;
  return accessibleBy(ability, 'read').ofType('RepairTicket');
}
