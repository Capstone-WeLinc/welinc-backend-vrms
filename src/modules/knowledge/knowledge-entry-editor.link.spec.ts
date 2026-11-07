import { Prisma, RepairStatus } from '@prisma/client';
import { UserRole } from '../../auth/roles';
import { PrismaService } from '../../shared/prisma.service';
import { CreateEntryDto } from './dto/create-entry.dto';
import { KnowledgeEntriesService } from './knowledge-entries.service';
import { KnowledgeEntryEditorService } from './knowledge-entry-editor.service';
import { JwtUser } from './knowledge-actor';

// Spec 0023, AC-14: an approved suggestion that copies steps onto a linked issue raises its
// checklistVersion with the copy, after taking the issue's row lock. An issue that already has its
// own checklist keeps it (decided during /develop, 2026-11-06).

const entry = { id: 'e1', name: 'Replace brake pads', categoryId: 'c1' };
const user = {
  sub: 'u1',
  email: 'chief@welinc.com',
  name: 'Chief',
  roles: [{ role: UserRole.CHIEF_MECHANIC, system: 'VRMS' }],
  system: 'VRMS',
} as unknown as JwtUser;

function setup(stepCounts: Record<string, number>) {
  const issues = Object.keys(stepCounts).map((id) => ({
    id,
    repairTicketId: `t-${id}`,
    categoryId: 'c1',
    knowledgeEntryId: null,
    suggestionDismissedAt: null,
    repairTicket: { repairStatus: RepairStatus.IN_PROGRESS },
  }));
  const tx = {
    repairIssue: {
      findMany: jest.fn().mockResolvedValue(issues),
      update: jest.fn().mockResolvedValue({}),
    },
    repairIssueStep: {
      count: jest.fn(({ where }: { where: { repairIssueId: string } }) =>
        Promise.resolve(stepCounts[where.repairIssueId]),
      ),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    auditLog: { createMany: jest.fn().mockResolvedValue({}) },
    repairTicket: { updateMany: jest.fn().mockResolvedValue({}) },
  };
  const service = new KnowledgeEntryEditorService(
    {} as PrismaService,
    {} as KnowledgeEntriesService,
  );
  // linkGroup is private: reached through a typed view of the service
  const editor = service as unknown as {
    linkGroup(
      tx: Prisma.TransactionClient,
      e: typeof entry,
      dto: CreateEntryDto,
      u: JwtUser,
    ): Promise<unknown>;
  };
  const dto = {
    steps: ['Lift the truck', 'Swap the pads'],
    linkIssueIds: Object.keys(stepCounts),
  } as CreateEntryDto;
  return {
    tx,
    run: () =>
      editor.linkGroup(
        tx as unknown as Prisma.TransactionClient,
        entry,
        dto,
        user,
      ),
  };
}

describe('KnowledgeEntryEditorService linkGroup (spec 0023, AC-14)', () => {
  it('copies steps with a version bump onto an issue with none, after its row lock', async () => {
    const { tx, run } = setup({ i1: 0 });
    await run();
    const sql = (tx.$queryRaw.mock.calls[0] as [string[]])[0].join('?');
    expect(sql).toMatch(/FOR UPDATE/);
    expect(tx.repairIssue.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: {
        knowledgeEntryId: 'e1',
        categoryId: 'c1',
        checklistVersion: { increment: 1 },
        steps: {
          create: [
            { position: 1, text: 'Lift the truck' },
            { position: 2, text: 'Swap the pads' },
          ],
        },
      },
    });
  });

  it('links an issue with its own checklist but keeps its steps and its version', async () => {
    const { tx, run } = setup({ i2: 3 });
    await run();
    expect(tx.repairIssue.update).toHaveBeenCalledWith({
      where: { id: 'i2' },
      data: { knowledgeEntryId: 'e1', categoryId: 'c1' },
    });
  });
});
