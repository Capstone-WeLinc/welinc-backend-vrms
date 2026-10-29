import { KnowledgeEntryStatus, Prisma, PrismaClient } from '@prisma/client';
import { DECLINED_SUGGESTIONS, PROBLEMS } from './catalog';
import {
  DAY,
  HOUR,
  between,
  chance,
  duringShopHours,
  int,
  pick,
  uuid,
} from './random';
import { seedActor } from './shared-ids';

const EDITORS = ['vrms.admin@welinc.com', 'vrms.chief@welinc.com'];

export type SeededEntry = {
  id: string;
  name: string;
  categoryId: string;
  status: KnowledgeEntryStatus;
  steps: string[];
  createdByEmail: string;
  createdAt: number;
  /** When it became pickable in the repair form; null for a draft. */
  activeFrom: number | null;
  /** When it was deactivated; null while active. */
  inactiveFrom: number | null;
};

const numbered = (items: string[]) =>
  items.map((item, i) => `${i + 1}. ${item}`).join('\n');

/** Knowledge entries for every problem that has one, with steps, parts and their change log. */
export async function seedKnowledge(prisma: PrismaClient, now: number) {
  console.log('Creating knowledge base entries...');

  // The categories come from the knowledge base migration, never from this seed
  const categories = await prisma.issueCategory.findMany();
  const categoryId = new Map(categories.map((c) => [c.name, c.id]));
  if (categoryId.size === 0) {
    throw new Error(
      'No issue categories found. Run `npx prisma migrate deploy` first, the migration seeds them.',
    );
  }

  const entries = new Map<string, SeededEntry>();
  const entryRows: Prisma.KnowledgeEntryCreateManyInput[] = [];
  const stepRows: Prisma.KnowledgeEntryStepCreateManyInput[] = [];
  const partRows: Prisma.KnowledgeEntryPartCreateManyInput[] = [];
  const changeRows: Prisma.KnowledgeEntryChangeCreateManyInput[] = [];

  for (const problem of PROBLEMS) {
    const spec = problem.entry;
    if (!spec) continue;
    const id = uuid();
    const author =
      spec.status === 'DRAFT' ? 'vrms.chief@welinc.com' : pick(EDITORS);
    const createdAt = duringShopHours(now - spec.writtenMonthsAgo * 30 * DAY);

    // Most entries were saved as a draft first and published a few days later
    const draftedFirst = spec.status !== 'DRAFT' && chance(0.6);
    const activeFrom =
      spec.status === 'DRAFT'
        ? null
        : draftedFirst
          ? duringShopHours(createdAt + between(1, 6) * DAY)
          : createdAt;
    const inactiveFrom =
      spec.status === 'INACTIVE'
        ? duringShopHours(now - (spec.deactivatedMonthsAgo ?? 1) * 30 * DAY)
        : null;

    const steps = spec.steps;
    const estimatedHours = spec.estimatedHours ?? null;
    let updatedAt = activeFrom ?? createdAt;
    let updatedBy = author;
    // One row per save, its field changes as a list (spec 0010)
    const log = (
      at: number,
      email: string,
      action: string,
      field: string,
      before: string | null,
      after: string | null,
    ) =>
      changeRows.push({
        id: uuid(),
        entryId: id,
        ...seedActor(email),
        action,
        changes: [{ field, before, after }],
        createdAt: new Date(at),
      });

    log(
      createdAt,
      author,
      'ENTRY_CREATED',
      'status',
      null,
      draftedFirst || spec.status === 'DRAFT' ? 'DRAFT' : 'ACTIVE',
    );
    if (draftedFirst) {
      log(activeFrom!, author, 'ENTRY_STATUS', 'status', 'DRAFT', 'ACTIVE');
    }

    // An editor tuned the estimate after the first few repairs
    if (spec.estimatedHours && activeFrom && chance(0.35)) {
      const at = duringShopHours(activeFrom + between(20, 60) * DAY);
      if (at < now - 7 * DAY) {
        const before = Math.max(
          0.25,
          spec.estimatedHours - pick([0.25, 0.5, 1]),
        );
        log(
          at,
          'vrms.chief@welinc.com',
          'ENTRY_UPDATED',
          'estimatedHours',
          String(before),
          String(spec.estimatedHours),
        );
        updatedAt = at;
        updatedBy = 'vrms.chief@welinc.com';
      }
    }

    // The accepted mechanic suggestion added the "count the threads" step to this entry
    if (spec.name === 'Worn tie rod ends') {
      const at = duringShopHours(now - 30 * DAY);
      const before = steps.filter((s) => !s.startsWith('Count the threads'));
      log(
        at,
        'vrms.chief@welinc.com',
        'ENTRY_UPDATED',
        'steps',
        numbered(before),
        numbered(steps),
      );
      updatedAt = at;
      updatedBy = 'vrms.chief@welinc.com';
    }

    if (inactiveFrom) {
      log(
        inactiveFrom,
        'vrms.admin@welinc.com',
        'ENTRY_STATUS',
        'status',
        'ACTIVE',
        'INACTIVE',
      );
      updatedAt = inactiveFrom;
      updatedBy = 'vrms.admin@welinc.com';
    }

    entryRows.push({
      id,
      name: spec.name,
      nameKey: spec.name.trim().toLowerCase(),
      categoryId: categoryId.get(problem.category)!,
      status: spec.status,
      symptoms: spec.symptoms,
      descriptionTemplate: spec.descriptionTemplate ?? null,
      suggestedPriority: problem.priority,
      estimatedHours,
      safetyNotes: spec.safetyNotes ?? null,
      createdByEmail: author,
      updatedByEmail: updatedBy,
      createdAt: new Date(createdAt),
      updatedAt: new Date(updatedAt),
    });
    steps.forEach((text, i) =>
      stepRows.push({ id: uuid(), entryId: id, position: i + 1, text }),
    );
    spec.parts.forEach((name, i) =>
      partRows.push({ id: uuid(), entryId: id, position: i + 1, name }),
    );

    entries.set(problem.key, {
      id,
      name: spec.name,
      categoryId: categoryId.get(problem.category)!,
      status: spec.status,
      steps,
      createdByEmail: author,
      createdAt,
      activeFrom,
      inactiveFrom,
    });
  }

  await prisma.knowledgeEntry.createMany({ data: entryRows });
  await prisma.knowledgeEntryStep.createMany({ data: stepRows });
  await prisma.knowledgeEntryPart.createMany({ data: partRows });
  await prisma.knowledgeEntryChange.createMany({ data: changeRows });

  // Mechanic suggestions an editor already handled (open ones are added with the tickets)
  const byName = new Map([...entries.values()].map((e) => [e.name, e]));
  await prisma.knowledgeSuggestion.createMany({
    data: DECLINED_SUGGESTIONS.map((s) => {
      const createdAt = duringShopHours(now - int(35, 50) * DAY);
      return {
        id: uuid(),
        kind: 'CHANGE' as const,
        status: s.status,
        entryId: byName.get(s.entry)!.id,
        body: s.body,
        createdByEmail: pick([
          'mech.juan@welinc.com',
          'mech.pedro@welinc.com',
          'mech.isabel@welinc.com',
        ]),
        resolvedByEmail: 'vrms.chief@welinc.com',
        resolvedAt: new Date(
          s.status === 'ACCEPTED'
            ? duringShopHours(now - 30 * DAY)
            : createdAt + int(1, 4) * DAY + HOUR,
        ),
        createdAt: new Date(createdAt),
      };
    }),
  });

  console.log(
    `  Created ${entryRows.length} entries (${entryRows.filter((e) => e.status === 'ACTIVE').length} active), ` +
      `${stepRows.length} steps, ${partRows.length} parts, ${changeRows.length} change log rows\n`,
  );
  return { entries, categoryId };
}
