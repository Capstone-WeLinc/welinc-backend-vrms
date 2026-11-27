// Role and system names as welinc-auth issues them. Accounts live in welinc-auth only
// (spec 0009). Suite spec 0018 child 0002, AC-34: a VRMS role is any code welinc-auth's catalog
// holds, custom roles included, and no code here decides behaviour by one; permissions do.
// The built in codes for test fixtures live in `built-in-roles.testing.ts`.

/** A role code from welinc-auth's catalog, such as a built in role or a custom `C_` role. */
export type RoleCode = string;

export const SystemType = {
  VRMS: 'VRMS',
  VMMS: 'VMMS',
  BMS: 'BMS',
} as const;
export type SystemType = (typeof SystemType)[keyof typeof SystemType];
