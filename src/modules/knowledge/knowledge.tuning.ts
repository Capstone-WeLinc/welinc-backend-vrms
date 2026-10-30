// Spec 0007 tuning constants that stay in code. The business values (minimum samples, repeat
// threshold and window, smallest group) are settings since spec 0012: read them through
// SettingsService.get and pass them in.
export const KNOWLEDGE_TUNING = {
  GROUP_SIMILARITY: 0.4,
  SEARCH_SIMILARITY: 0.3,
  GROUP_CANDIDATE_LIMIT: 500,
} as const;

export const ENTRIES_PAGE_SIZE = 20;
