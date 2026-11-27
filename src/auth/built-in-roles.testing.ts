// Test fixtures only: the role codes welinc-auth's catalog ships with. Production code never checks
// a role code (suite spec 0018 child 0002, AC-34); it asks the permissions.

export const UserRole = {
  ADMIN: 'ADMIN',
  MECHANIC: 'MECHANIC',
  CHIEF_MECHANIC: 'CHIEF_MECHANIC',
  CUSTOMER_SUPPORT: 'CUSTOMER_SUPPORT',
  OPERATIONS: 'OPERATIONS',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
