// Role and system names as welinc-auth issues them. Accounts live in welinc-auth only
// (spec 0009), so these are plain constants with the old Prisma enum member names.

export const UserRole = {
  ADMIN: 'ADMIN',
  MECHANIC: 'MECHANIC',
  CHIEF_MECHANIC: 'CHIEF_MECHANIC',
  CUSTOMER_SUPPORT: 'CUSTOMER_SUPPORT',
  OPERATIONS: 'OPERATIONS',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const SystemType = {
  VRMS: 'VRMS',
  VMMS: 'VMMS',
  BMS: 'BMS',
} as const;
export type SystemType = (typeof SystemType)[keyof typeof SystemType];
