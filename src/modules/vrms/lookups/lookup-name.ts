// Spec 0016, AC-19: a name is 1 to 100 characters after trimming; its key is the trimmed,
// lowercased name, and two names with one key in the same list are duplicates.

export const LOOKUP_NAME_MAX = 100;

export function lookupNameKey(name: string): string {
  return name.trim().toLowerCase();
}
