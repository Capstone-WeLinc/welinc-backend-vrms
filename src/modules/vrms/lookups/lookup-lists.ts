// Spec 0016, AC-19: the generic lookup lists. A list exists when it is in this catalog; values
// live in lookup_values, told apart by `list`.

export const VEHICLE_TYPE_LIST = 'vehicle_type';
export const CORPORATION_LIST = 'corporation';

export const LOOKUP_LISTS = {
  [VEHICLE_TYPE_LIST]: { title: 'Vehicle types' },
  [CORPORATION_LIST]: { title: 'Corporations' },
} as const;

export type LookupList = keyof typeof LOOKUP_LISTS;

export function isLookupList(name: string): name is LookupList {
  return Object.keys(LOOKUP_LISTS).includes(name);
}
