import { Injectable, NotFoundException } from '@nestjs/common';
import { subject } from '@casl/ability';
import { KnowledgeEntryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { FindEntriesQueryDto } from './dto/find-entries-query.dto';
import type { AppAbility } from '../../auth/permissions/ability.factory';
import { editsKnowledge } from './knowledge-actor';
import {
  EntryStats,
  loadRepeatVehicles,
  loadStats,
  searchEntryIds,
} from './knowledge-stats';
import { ENTRIES_PAGE_SIZE } from './knowledge.settings';

const toNumber = (value: Prisma.Decimal | null) =>
  value == null ? null : Number(value);

/** typicalCost leaves the response for anyone who is not an editor. */
function statsFor(stats: EntryStats, editor: boolean) {
  return {
    seenCount: stats.seenCount,
    lastSeenAt: stats.lastSeenAt,
    typicalHours: stats.typicalHours,
    hoursSamples: stats.hoursSamples,
    typicalDays: stats.typicalDays,
    ...(editor ? { typicalCost: stats.typicalCost } : {}),
  };
}

@Injectable()
export class KnowledgeEntriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /vrms/knowledge/entries (spec 0007, AC-8 to AC-10, Value sourcing). */
  async list(query: FindEntriesQueryDto, ability: AppAbility) {
    const editor = editsKnowledge(ability);
    const status = editor ? (query.status ?? 'ACTIVE') : 'ACTIVE';
    const statusWhere: Prisma.KnowledgeEntryWhereInput =
      status === 'ALL' ? {} : { status: status };

    const q = query.q?.trim();
    const matchedIds = q ? await searchEntryIds(this.prisma, q) : null;

    const where: Prisma.KnowledgeEntryWhereInput = {
      ...statusWhere,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(matchedIds ? { id: { in: matchedIds } } : {}),
    };

    const [entries, counts, libraryTotal] = await Promise.all([
      this.prisma.knowledgeEntry.findMany({
        where,
        include: { category: { select: { id: true, name: true } } },
      }),
      // Per category under the status filter only, not q or the chosen category
      this.prisma.knowledgeEntry.groupBy({
        by: ['categoryId'],
        where: statusWhere,
        _count: { _all: true },
      }),
      // Tells an empty library apart from a search with no match (AC-11)
      this.prisma.knowledgeEntry.count({
        where: editor ? {} : { status: KnowledgeEntryStatus.ACTIVE },
      }),
    ]);

    const stats = await loadStats(
      this.prisma,
      entries.map((e) => e.id),
    );
    const rows = entries.map((e) => ({ entry: e, stats: stats.get(e.id)! }));

    const byName = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
      a.entry.name.localeCompare(b.entry.name, undefined, {
        sensitivity: 'base',
      });
    const sort = query.sort ?? 'seen';
    rows.sort((a, b) => {
      if (sort === 'updated')
        return b.entry.updatedAt.getTime() - a.entry.updatedAt.getTime();
      if (sort === 'name') return byName(a, b);
      return b.stats.seenCount - a.stats.seenCount || byName(a, b);
    });

    const page = query.page ?? 1;
    const pageRows = rows.slice(
      (page - 1) * ENTRIES_PAGE_SIZE,
      page * ENTRIES_PAGE_SIZE,
    );

    return {
      data: pageRows.map(({ entry, stats: s }) => ({
        id: entry.id,
        name: entry.name,
        category: entry.category,
        status: entry.status,
        symptoms: entry.symptoms,
        estimatedHours: toNumber(entry.estimatedHours),
        updatedAt: entry.updatedAt,
        seenCount: s.seenCount,
        lastSeenAt: s.lastSeenAt,
        typicalHours: s.typicalHours,
        ...(editor ? { typicalCost: s.typicalCost } : {}),
      })),
      total: rows.length,
      libraryTotal,
      categoryCounts: Object.fromEntries(
        counts.map((c) => [c.categoryId, c._count._all]),
      ),
    };
  }

  /**
   * GET /vrms/knowledge/entries/options: every Active entry for the repair form picker and the
   * ticket's link Combobox, most seen first (AC-24, AC-27).
   */
  async options(ability: AppAbility) {
    const editor = editsKnowledge(ability);
    const entries = await this.prisma.knowledgeEntry.findMany({
      where: { status: KnowledgeEntryStatus.ACTIVE },
      include: { category: { select: { name: true } } },
    });
    const stats = await loadStats(
      this.prisma,
      entries.map((e) => e.id),
    );
    return entries
      .map((e) => ({ entry: e, stats: stats.get(e.id)! }))
      .sort(
        (a, b) =>
          b.stats.seenCount - a.stats.seenCount ||
          a.entry.name.localeCompare(b.entry.name, undefined, {
            sensitivity: 'base',
          }),
      )
      .map(({ entry, stats: s }) => ({
        id: entry.id,
        name: entry.name,
        categoryId: entry.categoryId,
        categoryName: entry.category.name,
        symptoms: entry.symptoms,
        suggestedPriority: entry.suggestedPriority,
        descriptionTemplate: entry.descriptionTemplate,
        estimatedHours: toNumber(entry.estimatedHours),
        seenCount: s.seenCount,
        typicalHours: s.typicalHours,
        ...(editor ? { typicalCost: s.typicalCost } : {}),
      }));
  }

  /** GET /vrms/knowledge/entries/:id. A mechanic gets 404 for anything not ACTIVE (AC-16). */
  async findOne(id: string, ability: AppAbility) {
    const editor = editsKnowledge(ability);
    const entry = await this.prisma.knowledgeEntry.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true, isActive: true } },
        steps: {
          orderBy: { position: 'asc' },
          select: { position: true, text: true },
        },
        parts: {
          orderBy: { position: 'asc' },
          select: { position: true, name: true },
        },
      },
    });
    // knowledge.view reads Active entries only; anything else is a 404, never a 403 (AC-13)
    if (!entry || !ability.can('read', subject('KnowledgeEntry', entry))) {
      throw new NotFoundException("This entry isn't available.");
    }

    const [stats, repeatVehicles, recentTickets] = await Promise.all([
      loadStats(this.prisma, [id]),
      loadRepeatVehicles(this.prisma, id),
      editor ? this.recentTickets(id) : Promise.resolve(null),
    ]);
    const s = stats.get(id)!;

    return {
      id: entry.id,
      name: entry.name,
      category: entry.category,
      status: entry.status,
      symptoms: entry.symptoms,
      descriptionTemplate: entry.descriptionTemplate,
      suggestedPriority: entry.suggestedPriority,
      estimatedHours: toNumber(entry.estimatedHours),
      safetyNotes: entry.safetyNotes,
      steps: entry.steps,
      parts: entry.parts,
      stats: {
        ...statsFor(s, editor),
        estimatedHours: toNumber(entry.estimatedHours),
      },
      repeatVehicles,
      ...(recentTickets ? { recentTickets } : {}),
      createdByEmail: entry.createdByEmail,
      updatedByEmail: entry.updatedByEmail,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  /** The last 5 tickets with an issue linked to this entry (AC-15). */
  private async recentTickets(entryId: string) {
    const tickets = await this.prisma.repairTicket.findMany({
      where: { issues: { some: { knowledgeEntryId: entryId } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        repairNumber: true,
        repairStatus: true,
        createdAt: true,
        vehicle: { select: { plateNumber: true } },
      },
    });
    return tickets.map((t) => ({
      id: t.id,
      repairNumber: t.repairNumber,
      status: t.repairStatus,
      plate: t.vehicle.plateNumber,
      createdAt: t.createdAt,
    }));
  }
}
