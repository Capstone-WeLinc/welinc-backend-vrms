// Spec 0030: test support for paths that now work out a due date inside their transaction.
// Adds the reads and writes recomputeDueAt and setDueAt make to a hand built Prisma mock,
// leaving any the spec already defines alone.

type MockClient = {
  repairTicket: Record<string, unknown>;
  auditLog?: Record<string, unknown>;
  [key: string]: unknown;
};

export const DUE_FAKE_CREATED_AT = new Date('2026-11-27T00:00:00.000Z');

/** The row loadDueInputs reads: a Low ticket with no issues, so its date is createdAt + 168 h. */
export function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    priority: 'LOW',
    createdAt: DUE_FAKE_CREATED_AT,
    dueAt: null,
    dueAtSource: null,
    repairStatus: 'OPEN',
    lastActivityAt: DUE_FAKE_CREATED_AT,
    issues: [],
    ...overrides,
  };
}

export function withDueDateMocks<T extends MockClient>(
  client: T,
  row: Record<string, unknown> = dueRow(),
): T {
  client.repairTicket.findUniqueOrThrow ??= jest.fn().mockResolvedValue(row);
  client.repairTicket.update ??= jest.fn().mockResolvedValue({});
  client.auditLog ??= {};
  client.auditLog.create ??= jest.fn().mockResolvedValue({});
  return client;
}
