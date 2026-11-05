import type { AuditChange, AuditEventData } from './audit-events';

// Spec 0023: the rules of a per ticket checklist save. Pure, so the diff, the moved set and the
// limits test without a database. The service applies what checklistDiff returns.

/** AC-5: the same limits as a knowledge entry's steps. */
export const STEPS_MAX = 20;
export const STEP_TEXT_MIN = 3;
export const STEP_TEXT_MAX = 300;

/** AC-6: a save whose checklistVersion no longer matches. Its own constant beside STALE_TICKET. */
export const STALE_CHECKLIST = {
  statusCode: 409,
  code: 'STALE_CHECKLIST',
  message:
    'This checklist changed since you opened it. Reload to see the latest.',
} as const;

export const CHECKLIST_STATUS_MESSAGE =
  'Steps can only be edited while the ticket is Assigned or In progress.';

/** AC-8: trimmed, each run of whitespace (spaces, tabs, newlines) turned into one space. */
export function normalizeStepText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** A step as stored, read FOR UPDATE inside the save. */
export type StoredStep = {
  id: string;
  position: number;
  text: string;
  checkedAt: Date | null;
  checkedByEmail: string | null;
  origin: 'KNOWN_FIX' | 'ADDED';
  editedAt: Date | null;
};

/** A step as sent: an id for a kept step, none for a new one. */
export type IncomingStep = { id?: string; text: string };

export type FieldError = { index: number; message: string };

/** One sent row that survives the empty new row drop, with its place in the sent list. */
export type CleanStep = { index: number; id?: string; text: string };

/**
 * AC-5: drops empty new rows, normalizes the rest and checks each against the limits. `index` is
 * the row's place in the sent list, so the dialog maps each message to its row.
 */
export function cleanSteps(incoming: IncomingStep[]): {
  steps: CleanStep[];
  fieldErrors: FieldError[];
} {
  const steps: CleanStep[] = [];
  const fieldErrors: FieldError[] = [];
  incoming.forEach((step, index) => {
    const text = normalizeStepText(step.text);
    if (!step.id && text === '') return;
    if (text.length < STEP_TEXT_MIN) {
      fieldErrors.push({
        index,
        message: `Write at least ${STEP_TEXT_MIN} characters.`,
      });
    } else if (text.length > STEP_TEXT_MAX) {
      fieldErrors.push({
        index,
        message: `Keep it to ${STEP_TEXT_MAX} characters.`,
      });
    }
    steps.push({ index, id: step.id, text });
  });
  if (steps.length > STEPS_MAX) {
    fieldErrors.push({
      index: steps[STEPS_MAX].index,
      message: `A checklist holds at most ${STEPS_MAX} steps.`,
    });
  }
  return { steps, fieldErrors };
}

/** AC-7: every id must be a stored step of this issue, and appear once. Null when they all are. */
export function idProblem(
  stored: StoredStep[],
  steps: CleanStep[],
): string | null {
  const known = new Set(stored.map((s) => s.id));
  const seen = new Set<string>();
  for (const step of steps) {
    if (!step.id) continue;
    if (!known.has(step.id)) {
      return 'A step in this list is not on this issue. Reload to see the latest.';
    }
    if (seen.has(step.id)) return 'The same step is in this list twice.';
    seen.add(step.id);
  }
  return null;
}

export type KeptStep = {
  stored: StoredStep;
  /** Final position, 1 to n in list order. */
  position: number;
  text: string;
  reworded: boolean;
  moved: boolean;
};

export type AddedStep = { position: number; text: string };

export type ChecklistDiff = {
  /** In their old order. */
  removed: StoredStep[];
  /** Every kept step, in list order. */
  kept: KeptStep[];
  /** In list order. */
  added: AddedStep[];
};

/**
 * AC-10: the indexes (into `values`) of the longest strictly increasing run. When two runs are
 * equally long, the one that ends earliest wins. Behind that end, each step back picks the
 * candidate with the lowest old position, so moving one step up marks that step, not the one it
 * jumped over ([s3, s1, s4] keeps s1 and s4, so s3 moved).
 */
export function longestRun(values: number[]): Set<number> {
  const n = values.length;
  if (n === 0) return new Set();
  const length = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j] >= values[i]) continue;
      const longer = length[j] + 1 > length[i];
      const lower = length[j] + 1 === length[i] && values[j] < values[prev[i]];
      if (longer || lower) {
        length[i] = length[j] + 1;
        prev[i] = j;
      }
    }
  }
  const best = Math.max(...length);
  let at = length.indexOf(best);
  const run = new Set<number>();
  while (at !== -1) {
    run.add(at);
    at = prev[at];
  }
  return run;
}

/**
 * AC-8 and AC-10: the stored steps against the cleaned list. A kept step is reworded only when its
 * normalized text differs, and moved only when it sits outside the longest run of kept steps that
 * stayed in their old order. A removed step and a new one with the same text stay a remove and an
 * add. Expects ids already checked by idProblem.
 */
export function checklistDiff(
  stored: StoredStep[],
  steps: CleanStep[],
): ChecklistDiff {
  const byId = new Map(stored.map((s) => [s.id, s]));
  const keptIds = new Set(steps.flatMap((s) => (s.id ? [s.id] : [])));
  const removed = stored
    .filter((s) => !keptIds.has(s.id))
    .sort((a, b) => a.position - b.position);

  const keptRows = steps.flatMap((step, i) =>
    step.id ? [{ step, stored: byId.get(step.id)!, position: i + 1 }] : [],
  );
  const run = longestRun(keptRows.map((k) => k.stored.position));
  const kept: KeptStep[] = keptRows.map((k, i) => ({
    stored: k.stored,
    position: k.position,
    text: k.step.text,
    reworded: k.step.text !== k.stored.text,
    moved: !run.has(i),
  }));
  const added = steps.flatMap((step, i) =>
    step.id ? [] : [{ position: i + 1, text: step.text }],
  );
  return { removed, kept, added };
}

/** AC-11: whether the save changes anything at all, positions included. */
export function hasChanges(diff: ChecklistDiff): boolean {
  return (
    diff.removed.length > 0 ||
    diff.added.length > 0 ||
    diff.kept.some((k) => k.reworded || k.position !== k.stored.position)
  );
}

// ── Audit rows (AC-10) ────────────────────────────────────────────────────────

const ids = (issueId: string, stepId: string): AuditChange[] => [
  { field: 'issueId', before: null, after: issueId },
  { field: 'stepId', before: null, after: stepId },
];

/** The tick a removal or a reword takes away, before and after empty. */
const tick = (step: StoredStep): AuditChange[] =>
  step.checkedAt
    ? [
        {
          field: 'checkedAt',
          before: step.checkedAt.toISOString(),
          after: null,
        },
        { field: 'checkedBy', before: step.checkedByEmail, after: null },
      ]
    : [];

export function stepRemovedEvent(
  step: StoredStep,
  issueId: string,
): AuditEventData {
  return {
    action: 'STEP_REMOVED',
    changes: [
      { field: 'position', before: String(step.position), after: null },
      { field: 'text', before: step.text, after: null },
      ...tick(step),
      ...ids(issueId, step.id),
    ],
    note: null,
  };
}

export function stepEditedEvent(
  step: KeptStep,
  issueId: string,
): AuditEventData {
  return {
    action: 'STEP_EDITED',
    changes: [
      { field: 'position', before: null, after: String(step.position) },
      { field: 'text', before: step.stored.text, after: step.text },
      ...tick(step.stored),
      ...ids(issueId, step.stored.id),
    ],
    note: null,
  };
}

export function stepMovedEvent(
  step: KeptStep,
  issueId: string,
): AuditEventData {
  return {
    action: 'STEP_MOVED',
    changes: [
      { field: 'text', before: null, after: step.text },
      {
        field: 'position',
        before: String(step.stored.position),
        after: String(step.position),
      },
      ...ids(issueId, step.stored.id),
    ],
    note: null,
  };
}

export function stepAddedEvent(
  step: AddedStep,
  stepId: string,
  issueId: string,
): AuditEventData {
  return {
    action: 'STEP_ADDED',
    changes: [
      { field: 'position', before: null, after: String(step.position) },
      { field: 'text', before: null, after: step.text },
      ...ids(issueId, stepId),
    ],
    note: null,
  };
}

/**
 * AC-10: every row a save writes, in the order removed, reworded, moved, added. `addedIds` are the
 * new steps' ids in the same order as `diff.added`.
 */
export function checklistEvents(
  diff: ChecklistDiff,
  addedIds: string[],
  issueId: string,
): AuditEventData[] {
  return [
    ...diff.removed.map((s) => stepRemovedEvent(s, issueId)),
    ...diff.kept
      .filter((k) => k.reworded)
      .map((k) => stepEditedEvent(k, issueId)),
    ...diff.kept.filter((k) => k.moved).map((k) => stepMovedEvent(k, issueId)),
    ...diff.added.map((a, i) => stepAddedEvent(a, addedIds[i], issueId)),
  ];
}
