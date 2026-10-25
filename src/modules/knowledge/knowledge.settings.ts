// Spec 0007: the one place the future settings spec (scope feature 46) replaces with stored settings.
export const KNOWLEDGE_SETTINGS = {
  /** Samples needed before a median replaces the estimate (AC-13). */
  MIN_SAMPLES: 3,
  /** Linked issues on one vehicle inside the window that make it "keep coming back" (AC-14). */
  REPEAT_THRESHOLD: 2,
  REPEAT_WINDOW_DAYS: 365,
  /** Smallest group of similar unlinked issues shown as a suggestion (AC-32). */
  GROUP_MIN_SIZE: 3,
  GROUP_SIMILARITY: 0.4,
  SEARCH_SIMILARITY: 0.3,
  GROUP_CANDIDATE_LIMIT: 500,
} as const;

export const ENTRIES_PAGE_SIZE = 20;
