import { BadRequestException, Injectable } from '@nestjs/common';
import {
  KnowledgeEntryStatus,
  Prisma,
  RepairStatus,
  SuggestionStatus,
} from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { CreateEntryDto } from './dto/create-entry.dto';
import { EntryFieldsDto, UpdateEntryDto } from './dto/entry-fields.dto';
import { UpdateEntryStatusDto } from './dto/update-entry-status.dto';
import { JwtUser } from './knowledge-actor';
import {
  changeRows,
  diffFields,
  duplicateConflict,
  EntrySnapshot,
  hoursText,
  isUniqueViolation,
  loadedAt,
  nameKey,
  notFound,
  numberedList,
  staleConflict,
} from './knowledge-changes';
import { KnowledgeEntriesService } from './knowledge-entries.service';
import {
  auditData,
  knowledgeLinkEvent,
  readChanges,
} from '../vrms/audit-events';
import { LINKABLE_STATUSES } from '../vrms/ticket-knowledge';

const STALE_ENTRY =
  'Someone else changed this entry. Reload to see their changes.';
const CHANGE_LOG_LIMIT = 200;

/** Spec 0007, State transitions. Any other move is 400. */
const ALLOWED_MOVES: Record<KnowledgeEntryStatus, KnowledgeEntryStatus[]> = {
  DRAFT: [KnowledgeEntryStatus.ACTIVE, KnowledgeEntryStatus.INACTIVE],
  ACTIVE: [KnowledgeEntryStatus.INACTIVE],
  INACTIVE: [KnowledgeEntryStatus.ACTIVE],
};

function snapshot(fields: EntryFieldsDto, categoryName: string): EntrySnapshot {
  return {
    name: fields.name,
    category: categoryName,
    suggestedPriority: fields.suggestedPriority,
    estimatedHours: hoursText(fields.estimatedHours),
    symptoms: fields.symptoms,
    descriptionTemplate: fields.descriptionTemplate ?? null,
    safetyNotes: fields.safetyNotes ?? null,
    steps: numberedList(fields.steps),
    parts: fields.parts?.length ? numberedList(fields.parts) : null,
  };
}

function entryData(fields: EntryFieldsDto, user: JwtUser) {
  return {
    name: fields.name,
    nameKey: nameKey(fields.name),
    categoryId: fields.categoryId,
    suggestedPriority: fields.suggestedPriority,
    estimatedHours: fields.estimatedHours ?? null,
    symptoms: fields.symptoms,
    descriptionTemplate: fields.descriptionTemplate ?? null,
    safetyNotes: fields.safetyNotes ?? null,
    updatedByEmail: user.email,
  };
}

const positioned = <K extends string>(items: string[], key: K) =>
  items.map((value, index) => ({ position: index + 1, [key]: value })) as ({
    position: number;
  } & Record<K, string>)[];

@Injectable()
export class KnowledgeEntryEditorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entries: KnowledgeEntriesService,
  ) {}

  /** POST /vrms/knowledge/entries (AC-17 to AC-19). */
  async create(dto: CreateEntryDto, user: JwtUser) {
    await this.activeCategory(dto.categoryId);
    await this.assertNameFree(dto.name);

    let id: string;
    let linked = 0;
    let skipped = 0;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const entry = await tx.knowledgeEntry.create({
          data: {
            ...entryData(dto, user),
            status: dto.status,
            createdByEmail: user.email,
            steps: { create: positioned(dto.steps, 'text') },
            parts: { create: positioned(dto.parts ?? [], 'name') },
          },
        });
        await tx.knowledgeEntryChange.createMany({
          data: changeRows(user, 'ENTRY_CREATED', { entryId: entry.id }, [
            { field: 'status', before: null, after: dto.status },
          ]),
        });
        ({ linked, skipped } = await this.linkGroup(tx, entry, dto, user));
        if (dto.suggestionId) {
          await tx.knowledgeSuggestion.updateMany({
            where: { id: dto.suggestionId, status: SuggestionStatus.OPEN },
            data: {
              status: SuggestionStatus.ACCEPTED,
              resolvedByEmail: user.email,
              resolvedAt: new Date(),
            },
          });
        }
        return entry.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw this.duplicate(dto.name);
      throw err;
    }

    return {
      entry: await this.entries.findOne(id, user),
      linked,
      skipped,
    };
  }

  /**
   * AC-33: links every still eligible issue of a suggestion group to the new entry. An issue already
   * linked, dismissed or on a cancelled ticket is skipped. Steps are copied only to Pending or In
   * progress tickets, and no ticket's updatedAt moves. Linking here records history, so it happens
   * for a draft too; only the picker and the ticket link are limited to Active entries.
   */
  private async linkGroup(
    tx: Prisma.TransactionClient,
    entry: { id: string; name: string; categoryId: string },
    dto: CreateEntryDto,
    user: JwtUser,
  ) {
    const ids = [...new Set(dto.linkIssueIds ?? [])];
    if (ids.length === 0) return { linked: 0, skipped: 0 };
    const issues = await tx.repairIssue.findMany({
      where: { id: { in: ids } },
      include: { repairTicket: { select: { repairStatus: true } } },
    });
    const eligible = issues.filter(
      (i) =>
        !i.knowledgeEntryId &&
        !i.suggestionDismissedAt &&
        i.repairTicket.repairStatus !== RepairStatus.CANCELLED,
    );
    for (const issue of eligible) {
      await tx.repairIssue.update({
        where: { id: issue.id },
        data: {
          knowledgeEntryId: entry.id,
          categoryId: issue.categoryId ?? entry.categoryId,
          ...(LINKABLE_STATUSES.includes(issue.repairTicket.repairStatus)
            ? { steps: { create: positioned(dto.steps, 'text') } }
            : {}),
        },
      });
    }
    // A person's audited action, so each linked ticket's lastActivityAt moves with it (spec 0010, AC-10)
    const now = new Date();
    await tx.auditLog.createMany({
      data: eligible.map((issue) => ({
        repairTicketId: issue.repairTicketId,
        ...auditData(user, knowledgeLinkEvent(issue.id, null, entry.name), now),
      })),
    });
    await tx.repairTicket.updateMany({
      where: {
        id: { in: [...new Set(eligible.map((i) => i.repairTicketId))] },
      },
      data: { lastActivityAt: now },
    });
    return { linked: eligible.length, skipped: ids.length - eligible.length };
  }

  /** PATCH /vrms/knowledge/entries/:id: every field, steps and parts replaced as a set (AC-20). */
  async update(id: string, dto: UpdateEntryDto, user: JwtUser) {
    const existing = await this.prisma.knowledgeEntry.findUnique({
      where: { id },
      include: {
        category: true,
        steps: { orderBy: { position: 'asc' } },
        parts: { orderBy: { position: 'asc' } },
      },
    });
    if (!existing) throw notFound('entry');

    const category =
      existing.categoryId === dto.categoryId
        ? existing.category
        : await this.activeCategory(dto.categoryId);
    await this.assertNameFree(dto.name, id);

    const before = snapshot(
      {
        ...existing,
        estimatedHours:
          existing.estimatedHours == null
            ? null
            : Number(existing.estimatedHours),
        steps: existing.steps.map((s) => s.text),
        parts: existing.parts.map((p) => p.name),
      },
      existing.category.name,
    );
    const changes = diffFields(before, snapshot(dto, category.name));

    try {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.knowledgeEntry.updateMany({
          where: { id, updatedAt: loadedAt(dto.lastUpdatedAt) },
          data: entryData(dto, user),
        });
        if (count === 0) throw staleConflict(STALE_ENTRY);

        await tx.knowledgeEntryStep.deleteMany({ where: { entryId: id } });
        await tx.knowledgeEntryStep.createMany({
          data: positioned(dto.steps, 'text').map((s) => ({
            ...s,
            entryId: id,
          })),
        });
        await tx.knowledgeEntryPart.deleteMany({ where: { entryId: id } });
        await tx.knowledgeEntryPart.createMany({
          data: positioned(dto.parts ?? [], 'name').map((p) => ({
            ...p,
            entryId: id,
          })),
        });
        await tx.knowledgeEntryChange.createMany({
          data: changeRows(user, 'ENTRY_UPDATED', { entryId: id }, changes),
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw this.duplicate(dto.name);
      throw err;
    }

    return this.entries.findOne(id, user);
  }

  /** PATCH /vrms/knowledge/entries/:id/status: Publish, Deactivate, Reactivate (AC-16). */
  async setStatus(id: string, dto: UpdateEntryStatusDto, user: JwtUser) {
    const existing = await this.prisma.knowledgeEntry.findUnique({
      where: { id },
      include: { category: true },
    });
    if (!existing) throw notFound('entry');
    if (!ALLOWED_MOVES[existing.status].includes(dto.status)) {
      throw new BadRequestException(
        `An entry can't move from ${existing.status.toLowerCase()} to ${dto.status.toLowerCase()}.`,
      );
    }
    // Keeps the invariant that an inactive category holds no Active or Draft entry.
    if (
      dto.status === KnowledgeEntryStatus.ACTIVE &&
      !existing.category.isActive
    ) {
      throw new BadRequestException(
        `Its category ${existing.category.name} is inactive. Reactivate the category or move the entry first.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.knowledgeEntry.updateMany({
        where: { id, updatedAt: loadedAt(dto.lastUpdatedAt) },
        data: { status: dto.status, updatedByEmail: user.email },
      });
      if (count === 0) throw staleConflict(STALE_ENTRY);
      await tx.knowledgeEntryChange.createMany({
        data: changeRows(user, 'ENTRY_STATUS', { entryId: id }, [
          {
            field: 'status',
            before: existing.status,
            after: dto.status,
          },
        ]),
      });
    });

    return this.entries.findOne(id, user);
  }

  /** GET /vrms/knowledge/entries/:id/changes, newest first (AC-16). */
  async changes(id: string) {
    const exists = await this.prisma.knowledgeEntry.count({ where: { id } });
    if (!exists) throw notFound('entry');
    const rows = await this.prisma.knowledgeEntryChange.findMany({
      where: { entryId: id },
      orderBy: { createdAt: 'desc' },
      take: CHANGE_LOG_LIMIT,
      select: {
        id: true,
        actorUserId: true,
        actorName: true,
        actorEmail: true,
        actorRole: true,
        action: true,
        changes: true,
        note: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({ ...row, changes: readChanges(row.changes) }));
  }

  /** An entry can only be created in, or moved to, an active category (Key invariants). */
  private async activeCategory(categoryId: string) {
    const category = await this.prisma.issueCategory.findUnique({
      where: { id: categoryId },
    });
    if (!category || !category.isActive) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: ['Choose an active category.'],
      });
    }
    return category;
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const clash = await this.prisma.knowledgeEntry.findUnique({
      where: { nameKey: nameKey(name) },
      select: { id: true },
    });
    if (clash && clash.id !== exceptId) throw this.duplicate(name);
  }

  private duplicate(name: string) {
    return duplicateConflict(`An entry named '${name}' already exists.`);
  }
}
