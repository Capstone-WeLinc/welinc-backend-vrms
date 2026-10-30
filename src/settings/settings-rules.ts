import { BadRequestException } from '@nestjs/common';
import {
  SETTINGS_CATALOG,
  SettingEntry,
  SettingValue,
  valueProblem,
} from './catalog';

// Spec 0012, AC-5 to AC-9, as pure functions so the rules run without a database. Each takes
// the catalog as a parameter, so the dependency rules can be proven on a test catalog (AC-9).

export const MAX_CHANGES = 50;
export const NOTE_MIN = 5;
export const NOTE_MAX = 500;

export type SettingChangeInput = {
  key: string;
  value?: unknown;
  reset?: boolean;
};

export type PlannedChange = {
  key: string;
  action: 'SET' | 'RESET';
  /** Effective values on each side; never null. */
  before: SettingValue;
  after: SettingValue;
  /** The row write: store a value, or delete the row. */
  write: { value: SettingValue } | 'delete';
  /** False only for a row deleted without changing the effective value. */
  logged: boolean;
};

export type SavePlan = { changes: PlannedChange[]; note: string | null };

/** A stored value that fails its entry's rules counts as no row (Key invariants). */
export function effectiveValue(
  entry: SettingEntry,
  stored: unknown,
): { value: SettingValue; valid: boolean } {
  if (stored === undefined) return { value: entry.default, valid: true };
  if (valueProblem(entry, stored) !== null) {
    return { value: entry.default, valid: false };
  }
  return { value: stored as SettingValue, valid: true };
}

/**
 * Turns a request into the rows to write and the changes to log. `stored` maps every stored key
 * to its raw value, read under the save lock. Throws 400 naming the key and the rule.
 */
export function planSave(
  input: readonly SettingChangeInput[],
  rawNote: string | undefined,
  stored: ReadonlyMap<string, unknown>,
  catalog: readonly SettingEntry[] = SETTINGS_CATALOG,
): SavePlan {
  if (input.length === 0) {
    throw new BadRequestException('Send at least one change.');
  }
  if (input.length > MAX_CHANGES) {
    throw new BadRequestException(
      `A save holds at most ${MAX_CHANGES} changes.`,
    );
  }

  const byKey = new Map(catalog.map((entry) => [entry.key, entry]));
  const requested = new Map<string, SettingChangeInput>();
  for (const change of input) {
    const entry = byKey.get(change.key);
    if (!entry) throw new BadRequestException(`Unknown setting: ${change.key}`);
    if (requested.has(change.key)) {
      throw new BadRequestException(`${change.key} appears twice.`);
    }
    const hasValue = change.value !== undefined;
    const hasReset = change.reset === true;
    if (hasValue === hasReset) {
      throw new BadRequestException(
        `${change.key}: send either a value or reset, not both or neither.`,
      );
    }
    if (hasValue) {
      const problem = valueProblem(entry, change.value);
      if (problem) throw new BadRequestException(`${change.key} ${problem}.`);
    }
    requested.set(change.key, change);
  }

  // The state before and after, by effective value
  const current = new Map<string, SettingValue>();
  for (const entry of catalog) {
    current.set(entry.key, effectiveValue(entry, stored.get(entry.key)).value);
  }
  const next = new Map(current);
  for (const change of requested.values()) {
    const entry = byKey.get(change.key)!;
    next.set(
      change.key,
      change.reset ? entry.default : (change.value as SettingValue),
    );
  }

  // AC-9: a module turned off takes every module that requires it along, transitively
  const cascaded = new Set<string>();
  const turnedOff = [...requested.keys()].filter(
    (key) => current.get(key) === true && next.get(key) === false,
  );
  while (turnedOff.length > 0) {
    const off = turnedOff.pop()!;
    for (const entry of catalog) {
      if (entry.kind !== 'module' || !entry.requires?.includes(off)) continue;
      if (next.get(entry.key) === false) continue;
      if (requested.has(entry.key)) {
        throw new BadRequestException(
          `${entry.label} needs ${byKey.get(off)?.label ?? off} on.`,
        );
      }
      next.set(entry.key, false);
      cascaded.add(entry.key);
      turnedOff.push(entry.key);
    }
  }

  // Checked on the state after the save, so no module is ever on without what it requires
  for (const entry of catalog) {
    if (entry.kind !== 'module' || next.get(entry.key) !== true) continue;
    for (const required of entry.requires ?? []) {
      if (next.get(required) !== true) {
        throw new BadRequestException(
          `${entry.label} needs ${byKey.get(required)?.label ?? required} on first.`,
        );
      }
    }
  }

  const changes: PlannedChange[] = [];
  for (const entry of catalog) {
    const before = current.get(entry.key)!;
    const after = next.get(entry.key)!;
    const change = requested.get(entry.key);
    if (cascaded.has(entry.key)) {
      changes.push({
        key: entry.key,
        action: 'SET',
        before,
        after,
        write: { value: after },
        logged: true,
      });
      continue;
    }
    if (!change) continue;

    if (change.reset) {
      // A reset of a key with no row is a no op; an invalid row is deleted and logged
      if (!stored.has(entry.key)) continue;
      const { valid } = effectiveValue(entry, stored.get(entry.key));
      changes.push({
        key: entry.key,
        action: 'RESET',
        before,
        after,
        write: 'delete',
        logged: before !== after || !valid,
      });
      continue;
    }
    // A change equal to the current effective value is skipped and not logged (AC-5)
    if (before === after) continue;
    changes.push({
      key: entry.key,
      action: 'SET',
      before,
      after,
      write: { value: after },
      logged: true,
    });
  }

  const note = rawNote?.trim() || null;
  const moduleMoved = changes.some(
    (c) =>
      c.logged && byKey.get(c.key)?.kind === 'module' && c.before !== c.after,
  );
  if (note && note.length > NOTE_MAX) {
    throw new BadRequestException(
      `The note is longer than ${NOTE_MAX} characters.`,
    );
  }
  // AC-8: a module change always carries a reason
  if (moduleMoved && (!note || note.length < NOTE_MIN)) {
    throw new BadRequestException(
      `Turning a module on or off needs a reason of ${NOTE_MIN} to ${NOTE_MAX} characters.`,
    );
  }

  return { changes, note };
}
