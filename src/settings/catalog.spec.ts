import {
  MODULES,
  moduleKey,
  SETTINGS_CATALOG,
  settingEntry,
  valueProblem,
  type SettingEntry,
} from './catalog';

// Spec 0012, AC-1: the one definition of settings

describe('SETTINGS_CATALOG', () => {
  it('holds exactly the 7 entries of the spec, in order (AC-1)', () => {
    expect(SETTINGS_CATALOG.map((entry) => entry.key)).toEqual([
      'module.ai',
      'module.analytics',
      'module.knowledge',
      'knowledge.min_samples',
      'knowledge.repeat_threshold',
      'knowledge.repeat_window_days',
      'knowledge.group_min_size',
    ]);
  });

  it('has no key twice', () => {
    const keys = SETTINGS_CATALOG.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('defaults every module to on, which the Python service relies on (AC-17)', () => {
    const modules = SETTINGS_CATALOG.filter((entry) => entry.kind === 'module');
    expect(modules).toHaveLength(MODULES.length);
    for (const entry of modules) expect(entry.default).toBe(true);
  });

  it('gives every module a key per module name and a list of what it hides (AC-22)', () => {
    for (const name of MODULES) {
      const entry = settingEntry(moduleKey(name));
      expect(entry?.kind).toBe('module');
      if (entry?.kind === 'module')
        expect(entry.hides.length).toBeGreaterThan(0);
    }
  });

  it('keeps every value default inside its own range and whole', () => {
    for (const entry of SETTINGS_CATALOG) {
      if (entry.kind !== 'value') continue;
      expect(entry.min).toBeLessThan(entry.max);
      expect(entry.default).toBeGreaterThanOrEqual(entry.min);
      expect(entry.default).toBeLessThanOrEqual(entry.max);
      expect(Number.isInteger(entry.default)).toBe(true);
    }
  });

  it('ties every value to a real module for the "module is off" note (AC-23)', () => {
    for (const entry of SETTINGS_CATALOG) {
      if (entry.kind === 'value' && entry.module) {
        expect(MODULES).toContain(entry.module);
      }
    }
  });
});

describe('settingEntry and moduleKey', () => {
  it('finds an entry by key and answers undefined for an unknown key', () => {
    expect(settingEntry('knowledge.min_samples')?.label).toMatch(/typical/i);
    expect(settingEntry('knowledge.nope')).toBeUndefined();
  });

  it('builds the module key from the module name', () => {
    expect(moduleKey('knowledge')).toBe('module.knowledge');
  });
});

describe('valueProblem', () => {
  const int = settingEntry('knowledge.min_samples') as SettingEntry;
  const bool = settingEntry('module.ai') as SettingEntry;

  it('accepts a whole number inside the range, including both ends (AC-6)', () => {
    expect(valueProblem(int, 1)).toBeNull();
    expect(valueProblem(int, 20)).toBeNull();
  });

  it.each([
    [0, 'must be between 1 and 20'],
    [21, 'must be between 1 and 20'],
    [2.5, 'must be a whole number'],
    ['3', 'must be a number'],
    [true, 'must be a number'],
    [null, 'must be a number'],
    [Number.NaN, 'must be a number'],
    [Infinity, 'must be a number'],
  ])('refuses %p for an int with "%s"', (value, problem) => {
    expect(valueProblem(int, value)).toBe(problem);
  });

  it('accepts only true or false for a module', () => {
    expect(valueProblem(bool, true)).toBeNull();
    expect(valueProblem(bool, false)).toBeNull();
    expect(valueProblem(bool, 1)).toBe('must be true or false');
    expect(valueProblem(bool, 'true')).toBe('must be true or false');
  });
});
