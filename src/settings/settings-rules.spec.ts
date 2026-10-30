import { BadRequestException } from '@nestjs/common';
import { SETTINGS_CATALOG, type SettingEntry } from './catalog';
import { effectiveValue, planSave } from './settings-rules';

// Spec 0012, AC-5 to AC-9: the save rules, without a database.

const none = new Map<string, unknown>();
const note = 'Testing the switch';

function refused(run: () => unknown, message: string | RegExp) {
  expect(run).toThrow(BadRequestException);
  expect(run).toThrow(message);
}

describe('effectiveValue', () => {
  const minSamples = SETTINGS_CATALOG.find(
    (e) => e.key === 'knowledge.min_samples',
  )!;

  it('takes the default when no row is stored (AC-2)', () => {
    expect(effectiveValue(minSamples, undefined)).toEqual({
      value: 3,
      valid: true,
    });
  });

  it('ignores a stored value that breaks the catalog rules (Key invariants)', () => {
    expect(effectiveValue(minSamples, 99)).toEqual({ value: 3, valid: false });
    expect(effectiveValue(minSamples, 'x')).toEqual({ value: 3, valid: false });
  });
});

describe('planSave on the real catalog', () => {
  // covers: AC-5
  it('sets a value and logs before and after', () => {
    const plan = planSave(
      [{ key: 'knowledge.repeat_threshold', value: 3 }],
      undefined,
      none,
    );
    expect(plan.changes).toEqual([
      {
        key: 'knowledge.repeat_threshold',
        action: 'SET',
        before: 2,
        after: 3,
        write: { value: 3 },
        logged: true,
      },
    ]);
  });

  // covers: AC-5
  it('skips a change equal to the effective value, and a reset with no row', () => {
    const plan = planSave(
      [
        { key: 'knowledge.repeat_threshold', value: 2 },
        { key: 'knowledge.min_samples', reset: true },
      ],
      undefined,
      none,
    );
    expect(plan.changes).toEqual([]);
  });

  // covers: AC-5
  it('resets to the default by deleting the row', () => {
    const plan = planSave(
      [{ key: 'knowledge.repeat_threshold', reset: true }],
      undefined,
      new Map([['knowledge.repeat_threshold', 5]]),
    );
    expect(plan.changes).toEqual([
      expect.objectContaining({
        action: 'RESET',
        before: 5,
        after: 2,
        write: 'delete',
        logged: true,
      }),
    ]);
  });

  it('deletes and logs an invalid stored row on reset, though the value stays the default', () => {
    const plan = planSave(
      [{ key: 'knowledge.repeat_threshold', reset: true }],
      undefined,
      new Map([['knowledge.repeat_threshold', 500]]),
    );
    expect(plan.changes).toEqual([
      expect.objectContaining({
        action: 'RESET',
        before: 2,
        after: 2,
        logged: true,
      }),
    ]);
  });

  // covers: AC-6
  it.each([
    [0, 'knowledge.min_samples must be between 1 and 20.'],
    [21, 'knowledge.min_samples must be between 1 and 20.'],
    [2.5, 'knowledge.min_samples must be a whole number.'],
    [true, 'knowledge.min_samples must be a number.'],
    ['3', 'knowledge.min_samples must be a number.'],
  ])('refuses %p for an int, naming the key and the rule', (value, message) => {
    refused(
      () =>
        planSave([{ key: 'knowledge.min_samples', value }], undefined, none),
      message,
    );
  });

  // covers: AC-6
  it('refuses an unknown key, a key twice, both or neither of value and reset, and too many changes', () => {
    refused(
      () => planSave([{ key: 'nope', value: 1 }], undefined, none),
      'Unknown setting: nope',
    );
    refused(
      () =>
        planSave(
          [
            { key: 'knowledge.min_samples', value: 4 },
            { key: 'knowledge.min_samples', value: 5 },
          ],
          undefined,
          none,
        ),
      'appears twice',
    );
    refused(
      () =>
        planSave(
          [{ key: 'knowledge.min_samples', value: 4, reset: true }],
          undefined,
          none,
        ),
      'either a value or reset',
    );
    refused(
      () => planSave([{ key: 'knowledge.min_samples' }], undefined, none),
      'either a value or reset',
    );
    refused(
      () =>
        planSave(
          Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, value: 1 })),
          undefined,
          none,
        ),
      'at most 50',
    );
    refused(
      () => planSave([{ key: 'module.ai', value: 1 }], note, none),
      'module.ai must be true or false.',
    );
  });

  // covers: AC-8
  it('needs a reason of 5 to 500 characters to move a module, and none for values', () => {
    refused(
      () => planSave([{ key: 'module.ai', value: false }], undefined, none),
      'needs a reason',
    );
    refused(
      () => planSave([{ key: 'module.ai', value: false }], ' abc ', none),
      'needs a reason',
    );
    refused(
      () =>
        planSave([{ key: 'module.ai', value: false }], 'x'.repeat(501), none),
      'longer than 500',
    );
    expect(
      planSave([{ key: 'module.ai', value: false }], note, none).note,
    ).toBe(note);
    expect(
      planSave([{ key: 'knowledge.min_samples', value: 4 }], undefined, none)
        .note,
    ).toBeNull();
  });

  it('needs no reason when a module switch would not change anything', () => {
    expect(
      planSave([{ key: 'module.ai', value: true }], undefined, none).changes,
    ).toEqual([]);
  });
});

// covers: AC-9. No real module requires another yet, so the rules run on this catalog.
describe('module dependencies on a test catalog', () => {
  const mod = (key: string, requires?: string[]): SettingEntry => ({
    key,
    kind: 'module',
    group: 'Modules',
    label: key.replace('module.', '').toUpperCase(),
    description: '',
    type: 'boolean',
    default: true,
    hides: [],
    ...(requires ? { requires } : {}),
  });
  // C needs B, B needs A
  const catalog = [
    mod('module.a'),
    mod('module.b', ['module.a']),
    mod('module.c', ['module.b']),
  ];

  it('turns off every module that requires the one turned off, transitively, each logged', () => {
    const plan = planSave(
      [{ key: 'module.a', value: false }],
      note,
      none,
      catalog,
    );
    expect(
      plan.changes.map((c) => [c.key, c.before, c.after, c.logged]),
    ).toEqual([
      ['module.a', true, false, true],
      ['module.b', true, false, true],
      ['module.c', true, false, true],
    ]);
    expect(plan.note).toBe(note);
  });

  it('refuses turning a module on while a module it requires is off', () => {
    const stored = new Map<string, unknown>([
      ['module.a', false],
      ['module.b', false],
    ]);
    refused(
      () => planSave([{ key: 'module.b', value: true }], note, stored, catalog),
      'B needs A on first.',
    );
  });

  it('lets one save turn the required module on with its dependent', () => {
    const stored = new Map<string, unknown>([
      ['module.a', false],
      ['module.b', false],
    ]);
    const plan = planSave(
      [
        { key: 'module.a', value: true },
        { key: 'module.b', value: true },
      ],
      note,
      stored,
      catalog,
    );
    expect(plan.changes.map((c) => c.key)).toEqual(['module.a', 'module.b']);
  });

  it('refuses turning a module off while the same save turns its dependent on', () => {
    const stored = new Map<string, unknown>([['module.b', false]]);
    refused(
      () =>
        planSave(
          [
            { key: 'module.a', value: false },
            { key: 'module.b', value: true },
          ],
          note,
          stored,
          catalog,
        ),
      'B needs A on',
    );
  });
});
