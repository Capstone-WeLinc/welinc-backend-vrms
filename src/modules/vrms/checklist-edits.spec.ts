import {
  checklistDiff,
  checklistEvents,
  cleanSteps,
  hasChanges,
  idProblem,
  longestRun,
  normalizeStepText,
  type StoredStep,
} from './checklist-edits';

// Spec 0023: the normalizer, the limits, the diff, the moved set and its tie rule, and the audit
// rows a save writes. Pure, so no database.

const ISSUE = '00000000-0000-4000-8000-0000000000bb';
const TICKED = new Date('2026-11-06T02:00:00.000Z');

function stored(n: number, ticked: number[] = []): StoredStep[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    position: i + 1,
    text: `Step ${i + 1}`,
    checkedAt: ticked.includes(i + 1) ? TICKED : null,
    checkedByEmail: ticked.includes(i + 1) ? 'mech@welinc.com' : null,
    origin: 'KNOWN_FIX' as const,
    editedAt: null,
  }));
}

/** Kept steps by id with their stored text, in the order given. */
const keep = (...ids: string[]) =>
  ids.map((id, index) => ({ index, id, text: `Step ${id.slice(1)}` }));

const moved = (steps: StoredStep[], order: string[]) =>
  checklistDiff(steps, keep(...order))
    .kept.filter((k) => k.moved)
    .map((k) => k.stored.id);

describe('normalizeStepText (AC-8)', () => {
  it('trims and turns each run of spaces, tabs and newlines into one space', () => {
    expect(normalizeStepText('  Torque \t the\n\ncaliper   bolts ')).toBe(
      'Torque the caliper bolts',
    );
  });
});

describe('cleanSteps (AC-5)', () => {
  it('drops empty new rows and keeps the sent index on the rest', () => {
    const { steps, fieldErrors } = cleanSteps([
      { text: '   ' },
      { id: 's1', text: 'Bleed the brakes' },
      { text: 'Top up fluid' },
    ]);
    expect(fieldErrors).toEqual([]);
    expect(steps).toEqual([
      { index: 1, id: 's1', text: 'Bleed the brakes' },
      { index: 2, id: undefined, text: 'Top up fluid' },
    ]);
  });

  it('flags a short step, an emptied kept step and a long step by their sent index', () => {
    const { fieldErrors } = cleanSteps([
      { text: 'ab' },
      { id: 's1', text: '  ' },
      { text: 'x'.repeat(301) },
      { text: 'x'.repeat(300) },
    ]);
    expect(fieldErrors).toEqual([
      { index: 0, message: 'Write at least 3 characters.' },
      { index: 1, message: 'Write at least 3 characters.' },
      { index: 2, message: 'Keep it to 300 characters.' },
    ]);
  });

  it('counts length after normalizing', () => {
    expect(cleanSteps([{ text: ' a  b ' }]).fieldErrors).toEqual([]);
    expect(cleanSteps([{ text: ' a   ' }]).fieldErrors).toHaveLength(1);
  });

  it('allows 0 steps and refuses a 21st', () => {
    expect(cleanSteps([])).toEqual({ steps: [], fieldErrors: [] });
    const many = Array.from({ length: 21 }, (_, i) => ({ text: `Step ${i}` }));
    expect(cleanSteps(many).fieldErrors).toEqual([
      { index: 20, message: 'A checklist holds at most 20 steps.' },
    ]);
  });
});

describe('idProblem (AC-7)', () => {
  it('refuses an id that is not a step of this issue', () => {
    expect(idProblem(stored(2), keep('s1', 's9'))).toMatch(/not on this issue/);
  });

  it('refuses the same id twice', () => {
    expect(idProblem(stored(2), keep('s1', 's1'))).toMatch(/twice/);
  });

  it('accepts kept ids and new rows', () => {
    expect(
      idProblem(stored(2), [...keep('s2'), { index: 1, text: 'New one' }]),
    ).toBeNull();
  });
});

describe('the moved set (AC-10)', () => {
  it('moves only the last step when it goes to the top', () => {
    expect(moved(stored(5), ['s5', 's1', 's2', 's3', 's4'])).toEqual(['s5']);
  });

  it('moves only the first step when it goes to the bottom', () => {
    expect(moved(stored(5), ['s2', 's3', 's4', 's5', 's1'])).toEqual(['s1']);
  });

  it('writes one move for a swap, keeping the run that ends earliest', () => {
    // [s2, s1]: both runs are one long; s2's ends first, so s1 is the one that moved
    expect(moved(stored(2), ['s2', 's1'])).toEqual(['s1']);
    // Equal ends: the run through the lower old position stays, so s3 is the one that moved
    expect(moved(stored(4), ['s1', 's3', 's2', 's4'])).toEqual(['s3']);
  });

  it('marks the step that went up, not the one it jumped over', () => {
    expect(moved(stored(4), ['s3', 's1', 's4'])).toEqual(['s3']);
  });

  it('moves nothing when only removals and additions shift positions', () => {
    const diff = checklistDiff(stored(3), [
      { index: 0, text: 'Brand new' },
      ...keep('s1', 's3').map((k) => ({ ...k, index: k.index + 1 })),
    ]);
    expect(diff.kept.filter((k) => k.moved)).toEqual([]);
    expect(diff.removed.map((s) => s.id)).toEqual(['s2']);
    expect(diff.added).toEqual([{ position: 1, text: 'Brand new' }]);
    expect(diff.kept.map((k) => [k.stored.id, k.position])).toEqual([
      ['s1', 2],
      ['s3', 3],
    ]);
  });

  it('gives the longest increasing run, earliest ending on a tie', () => {
    expect([...longestRun([3, 1, 2])].sort()).toEqual([1, 2]);
    expect([...longestRun([2, 1])]).toEqual([0]);
    expect([...longestRun([])]).toEqual([]);
  });
});

describe('checklistDiff (AC-8, AC-11)', () => {
  it('rewords only when the normalized text differs', () => {
    const steps = stored(2);
    const same = checklistDiff(steps, [
      { index: 0, id: 's1', text: normalizeStepText('  Step   1 ') },
      { index: 1, id: 's2', text: 'Step 2' },
    ]);
    expect(same.kept.some((k) => k.reworded)).toBe(false);
    expect(hasChanges(same)).toBe(false);

    const changed = checklistDiff(steps, [
      { index: 0, id: 's1', text: 'Step one, torqued' },
      { index: 1, id: 's2', text: 'Step 2' },
    ]);
    expect(changed.kept.map((k) => k.reworded)).toEqual([true, false]);
    expect(hasChanges(changed)).toBe(true);
  });

  it('treats a removed step and a new one with the same text as a remove and an add', () => {
    const diff = checklistDiff(stored(2), [
      ...keep('s1'),
      { index: 1, text: 'Step 2' },
    ]);
    expect(diff.removed.map((s) => s.id)).toEqual(['s2']);
    expect(diff.added).toEqual([{ position: 2, text: 'Step 2' }]);
    expect(diff.kept.some((k) => k.moved)).toBe(false);
  });

  it('removes everything on an empty list', () => {
    const diff = checklistDiff(stored(3), []);
    expect(diff.removed).toHaveLength(3);
    expect(hasChanges(diff)).toBe(true);
  });
});

describe('checklistEvents (AC-10)', () => {
  it('writes removed, reworded, moved, added in that order, with their changes', () => {
    const steps = stored(4, [2, 3]);
    // Remove s2 (ticked), reword s3 (ticked) and move it to the top, keep s1 and s4, add one
    const diff = checklistDiff(steps, [
      { index: 0, id: 's3', text: 'Step three, reworded' },
      ...keep('s1', 's4').map((k) => ({ ...k, index: k.index + 1 })),
      { index: 3, text: 'Road test' },
    ]);
    const events = checklistEvents(diff, ['new1'], ISSUE);
    expect(events.map((e) => e.action)).toEqual([
      'STEP_REMOVED',
      'STEP_EDITED',
      'STEP_MOVED',
      'STEP_ADDED',
    ]);
    const [removed, edited, movedRow, added] = events.map((e) => e.changes);
    expect(removed).toEqual([
      { field: 'position', before: '2', after: null },
      { field: 'text', before: 'Step 2', after: null },
      { field: 'checkedAt', before: TICKED.toISOString(), after: null },
      { field: 'checkedBy', before: 'mech@welinc.com', after: null },
      { field: 'issueId', before: null, after: ISSUE },
      { field: 'stepId', before: null, after: 's2' },
    ]);
    expect(edited).toEqual([
      { field: 'position', before: null, after: '1' },
      { field: 'text', before: 'Step 3', after: 'Step three, reworded' },
      { field: 'checkedAt', before: TICKED.toISOString(), after: null },
      { field: 'checkedBy', before: 'mech@welinc.com', after: null },
      { field: 'issueId', before: null, after: ISSUE },
      { field: 'stepId', before: null, after: 's3' },
    ]);
    expect(movedRow).toEqual([
      { field: 'text', before: null, after: 'Step three, reworded' },
      { field: 'position', before: '3', after: '1' },
      { field: 'issueId', before: null, after: ISSUE },
      { field: 'stepId', before: null, after: 's3' },
    ]);
    expect(added).toEqual([
      { field: 'position', before: null, after: '4' },
      { field: 'text', before: null, after: 'Road test' },
      { field: 'issueId', before: null, after: ISSUE },
      { field: 'stepId', before: null, after: 'new1' },
    ]);
  });

  it('leaves the tick fields off an unticked step', () => {
    const diff = checklistDiff(stored(1), []);
    expect(
      checklistEvents(diff, [], ISSUE)[0].changes.map((c) => c.field),
    ).toEqual(['position', 'text', 'issueId', 'stepId']);
  });
});
