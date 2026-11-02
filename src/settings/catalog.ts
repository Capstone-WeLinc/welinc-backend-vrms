// Spec 0012, AC-1: the one definition of settings. app_settings stores only the values an Admin
// changed; a key with no row takes its default here (AC-2).
//
// Rule for later features: a new tunable is one entry here, read through SettingsService.get.
// Every module defaults to on, and the Python service relies on that (AC-17).

export const MODULES = ['ai', 'analytics', 'knowledge'] as const;
export type ModuleName = (typeof MODULES)[number];

export const MODULE_LABELS: Record<ModuleName, string> = {
  ai: 'AI',
  analytics: 'Analytics',
  knowledge: 'Knowledge base',
};

type BaseEntry = {
  key: string;
  group: string;
  label: string;
  description: string;
};

export type ModuleEntry = BaseEntry & {
  kind: 'module';
  type: 'boolean';
  default: boolean;
  /** What turns off with it, shown in the confirm dialog. */
  hides: readonly string[];
  /** Module keys this one needs on (AC-9). */
  requires?: readonly string[];
};

export type ValueEntry = BaseEntry & {
  kind: 'value';
  type: 'int';
  default: number;
  min: number;
  max: number;
  unit: string;
  /** The module this value belongs to, for the hub's "module is off" note (AC-23). */
  module?: ModuleName;
};

/** A yes or no value that is not a module switch (spec 0015). */
export type ToggleEntry = BaseEntry & {
  kind: 'value';
  type: 'boolean';
  default: boolean;
  module?: ModuleName;
};

export type SettingEntry = ModuleEntry | ValueEntry | ToggleEntry;
export type SettingValue = number | boolean;

export const SETTINGS_CATALOG = [
  {
    key: 'module.ai',
    kind: 'module',
    group: 'Modules',
    label: 'AI',
    description: 'AI diagnosis on repair tickets and the AI service behind it.',
    type: 'boolean',
    default: true,
    hides: [
      'AI diagnosis panel on repair tickets',
      'AI feedback',
      'Issue embedding',
    ],
  },
  {
    key: 'module.analytics',
    kind: 'module',
    group: 'Modules',
    label: 'Analytics',
    description: 'Fleet analytics dashboards and the data refresh behind them.',
    type: 'boolean',
    default: true,
    hides: ['Analytics page and its charts', 'The analytics data refresh'],
  },
  {
    key: 'module.knowledge',
    kind: 'module',
    group: 'Modules',
    label: 'Knowledge base',
    description: 'The fix library, its suggestions and known fixes on tickets.',
    type: 'boolean',
    default: true,
    hides: [
      'Knowledge base pages',
      'Suggestions',
      "The repair form's known fix picker and auto fill",
      'The "What fixed it" step',
    ],
  },
  {
    key: 'knowledge.min_samples',
    kind: 'value',
    group: 'Knowledge base',
    label: 'Repairs before typical time and cost',
    description:
      'Closed repairs needed before the typical time and cost replace the estimate.',
    type: 'int',
    default: 3,
    min: 1,
    max: 20,
    unit: 'repairs',
    module: 'knowledge',
  },
  {
    key: 'knowledge.repeat_threshold',
    kind: 'value',
    group: 'Knowledge base',
    label: 'Repairs that mark a repeat vehicle',
    description:
      'Linked repairs on one vehicle that make it "keeps coming back".',
    type: 'int',
    default: 2,
    min: 2,
    max: 10,
    unit: 'repairs',
    module: 'knowledge',
  },
  {
    key: 'knowledge.repeat_window_days',
    kind: 'value',
    group: 'Knowledge base',
    label: 'Repeat window',
    description: 'How far back the repeat count looks.',
    type: 'int',
    default: 365,
    min: 30,
    max: 1095,
    unit: 'days',
    module: 'knowledge',
  },
  {
    key: 'knowledge.group_min_size',
    kind: 'value',
    group: 'Knowledge base',
    label: 'Smallest suggested group',
    description:
      'Similar unlinked issues needed before they show as a suggestion.',
    type: 'int',
    default: 3,
    min: 2,
    max: 20,
    unit: 'issues',
    module: 'knowledge',
  },
  {
    // Spec 0013, AC-18
    key: 'ai.embed_catchup_days',
    kind: 'value',
    group: 'AI',
    label: 'Embedding catch up window',
    description:
      'How far back the catch up job looks for issues that have no embedding yet.',
    type: 'int',
    default: 30,
    min: 1,
    max: 365,
    unit: 'days',
    module: 'ai',
  },
  {
    // Spec 0015, AC-4
    key: 'tickets.require_costs_to_close',
    kind: 'value',
    group: 'Tickets',
    label: 'Require costs before closing',
    description:
      'A ticket cannot be verified and closed until it has costs recorded.',
    type: 'boolean',
    default: false,
  },
  {
    // Spec 0016, AC-8
    key: 'tickets.odometer_jump_warn_km',
    kind: 'value',
    group: 'Tickets',
    label: 'Odometer jump that needs a check',
    description:
      'A new ticket reading this far above the truck’s last reading must be confirmed as right.',
    type: 'int',
    default: 20000,
    min: 1000,
    max: 200000,
    unit: 'km',
  },
  {
    // Spec 0017, AC-5
    key: 'uploads.max_file_mb',
    kind: 'value',
    group: 'Files',
    label: 'Largest file',
    description:
      'The biggest photo or document anyone can attach to a ticket. Never more than 25 MB.',
    type: 'int',
    default: 10,
    min: 1,
    max: 25,
    unit: 'MB',
  },
  {
    // Spec 0017, AC-9; relabelled by spec 0018, AC-3
    key: 'uploads.max_vehicle_photos',
    kind: 'value',
    group: 'Files',
    label: 'Before photos per ticket',
    description:
      'How many before photos (how the truck arrived) one ticket can hold.',
    type: 'int',
    default: 5,
    min: 1,
    max: 20,
    unit: 'photos',
  },
  {
    // Spec 0018, AC-3
    key: 'uploads.max_after_photos',
    kind: 'value',
    group: 'Files',
    label: 'After photos per ticket',
    description:
      'How many after photos (proof the fix is done) one ticket can hold.',
    type: 'int',
    default: 10,
    min: 1,
    max: 30,
    unit: 'photos',
  },
  {
    // Spec 0017, AC-9
    key: 'uploads.max_documents',
    kind: 'value',
    group: 'Files',
    label: 'Documents per ticket',
    description:
      'How many receipts and other documents one ticket can hold, together.',
    type: 'int',
    default: 20,
    min: 1,
    max: 100,
    unit: 'documents',
  },
] as const satisfies readonly SettingEntry[];

export type SettingKey = (typeof SETTINGS_CATALOG)[number]['key'];

/** The typed value of a key: boolean for a module, number for an int. */
export type SettingValueOf<K extends SettingKey> = Extract<
  (typeof SETTINGS_CATALOG)[number],
  { key: K }
>['type'] extends 'boolean'
  ? boolean
  : number;

export function moduleKey(name: ModuleName): `module.${ModuleName}` {
  return `module.${name}`;
}

const BY_KEY = new Map<string, SettingEntry>(
  SETTINGS_CATALOG.map((entry) => [entry.key, entry]),
);

export function settingEntry(key: string): SettingEntry | undefined {
  return BY_KEY.get(key);
}

/** Why a value breaks its entry's rules, or null when it is valid (AC-6). */
export function valueProblem(
  entry: SettingEntry,
  value: unknown,
): string | null {
  if (entry.type === 'boolean') {
    return typeof value === 'boolean' ? null : 'must be true or false';
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'must be a number';
  }
  if (!Number.isInteger(value)) return 'must be a whole number';
  if (value < entry.min || value > entry.max) {
    return `must be between ${entry.min} and ${entry.max}`;
  }
  return null;
}
