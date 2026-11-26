import type { DeliveryKind, DeliveryTarget } from '@prisma/client';

// Spec 0029 (child 0004): where each kind of message goes, and the service token it needs.

/** The ticket columns that count each system's accepted versions. */
export type VersionColumn = 'vmmsEventVersion' | 'bmsEventVersion';

export type KindRoute = {
  target: DeliveryTarget;
  path: string;
  audience: 'VMMS' | 'BMS';
  scope: string;
  /**
   * The ticket column holding the last version the other system accepted. The worker fills
   * `eventVersion` from it at send time, so versions never skip.
   */
  versionColumn?: VersionColumn;
};

export const KIND_ROUTES: Record<DeliveryKind, KindRoute> = {
  REPAIR_EVENT: {
    target: 'VMMS',
    path: '/vmms/integrations/vrms/repair-events',
    audience: 'VMMS',
    scope: 'fleet.repair-status.write',
    versionColumn: 'vmmsEventVersion',
  },
  REFERRAL_REJECTED: {
    target: 'VMMS',
    path: '/vmms/integrations/vrms/referral-events',
    audience: 'VMMS',
    scope: 'repair.referral-status.write',
  },
  REPAIR_UPDATE: {
    target: 'BMS',
    path: '/bms/integrations/vrms/repair-updates',
    audience: 'BMS',
    scope: 'repair.update.write',
    versionColumn: 'bmsEventVersion',
  },
  EXPEDITE_ANSWER: {
    target: 'BMS',
    path: '/bms/integrations/vrms/expedite-answers',
    audience: 'BMS',
    scope: 'repair.update.write',
  },
};
