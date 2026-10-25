import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  KnowledgeEntryStatus,
  SuggestionKind,
  SuggestionStatus,
} from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import {
  CreateSuggestionDto,
  DismissGroupDto,
  ResolveSuggestionDto,
} from './dto/suggestion.dto';
import { isKnowledgeEditor, JwtUser } from './knowledge-actor';
import { findIssueGroups } from './knowledge-grouping';

@Injectable()
export class KnowledgeSuggestionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /vrms/knowledge/suggestions: recurring problems and open mechanic suggestions (AC-32, AC-35). */
  async list() {
    const [groupIds, suggestions] = await Promise.all([
      findIssueGroups(this.prisma),
      this.openSuggestions(),
    ]);

    const issues = await this.prisma.repairIssue.findMany({
      where: { id: { in: groupIds.flat() } },
      select: {
        id: true,
        description: true,
        resolutionNote: true,
        createdAt: true,
        categoryId: true,
        category: { select: { name: true } },
        repairTicket: { select: { id: true, repairNumber: true } },
      },
    });
    const byId = new Map(issues.map((i) => [i.id, i]));

    const groups = groupIds.map((ids) => {
      const members = ids.flatMap((id) =>
        byId.has(id) ? [byId.get(id)!] : [],
      );
      const categoryIds = new Set(members.map((m) => m.categoryId));
      const shared = categoryIds.size === 1 ? members[0] : undefined;
      return {
        issueIds: ids,
        size: ids.length,
        // The category when every issue shares one
        categoryId: shared?.categoryId ?? null,
        categoryName: shared?.category?.name ?? null,
        issues: members.map((m) => ({
          issueId: m.id,
          ticketId: m.repairTicket.id,
          repairNumber: m.repairTicket.repairNumber,
          description: m.description,
          resolutionNote: m.resolutionNote,
          createdAt: m.createdAt,
        })),
      };
    });

    return { groups, suggestions, openCount: suggestions.length };
  }

  /** GET /vrms/knowledge/suggestions/count: open mechanic suggestions only, for the tab badge (AC-36). */
  async count() {
    const openCount = await this.prisma.knowledgeSuggestion.count({
      where: { status: SuggestionStatus.OPEN },
    });
    return { openCount };
  }

  /** POST /vrms/knowledge/suggestions, by any reader (AC-35). */
  async create(dto: CreateSuggestionDto, user: JwtUser) {
    if (dto.kind === SuggestionKind.CHANGE) {
      if (!dto.entryId) {
        throw new BadRequestException('Choose the entry to change.');
      }
      // A mechanic can only see Active entries, so only those can be suggested on
      const entry = await this.prisma.knowledgeEntry.findFirst({
        where: {
          id: dto.entryId,
          ...(isKnowledgeEditor(user)
            ? {}
            : { status: KnowledgeEntryStatus.ACTIVE }),
        },
        select: { id: true },
      });
      if (!entry) throw new NotFoundException("This entry isn't available.");
    }
    if (dto.repairIssueId) {
      const issue = await this.prisma.repairIssue.count({
        where: { id: dto.repairIssueId },
      });
      if (!issue) throw new NotFoundException('That issue was not found.');
    }

    return this.prisma.knowledgeSuggestion.create({
      data: {
        kind: dto.kind,
        entryId: dto.kind === SuggestionKind.CHANGE ? dto.entryId : null,
        repairIssueId: dto.repairIssueId ?? null,
        body: dto.body,
        createdByEmail: user.email,
      },
    });
  }

  /** PATCH /vrms/knowledge/suggestions/:id: Mark done or Dismiss (AC-35). */
  async resolve(id: string, dto: ResolveSuggestionDto, user: JwtUser) {
    const suggestion = await this.prisma.knowledgeSuggestion.findUnique({
      where: { id },
    });
    if (!suggestion) throw new NotFoundException('Suggestion not found.');
    if (suggestion.status !== SuggestionStatus.OPEN) {
      throw new BadRequestException('This suggestion is already closed.');
    }
    return this.prisma.knowledgeSuggestion.update({
      where: { id },
      data: {
        status: dto.status,
        resolvedByEmail: user.email,
        resolvedAt: new Date(),
      },
    });
  }

  /** POST /vrms/knowledge/suggestions/dismiss-group (AC-34). Linked issues are left alone. */
  async dismissGroup(dto: DismissGroupDto) {
    const { count } = await this.prisma.repairIssue.updateMany({
      where: {
        id: { in: dto.issueIds },
        knowledgeEntryId: null,
        suggestionDismissedAt: null,
      },
      data: { suggestionDismissedAt: new Date() },
    });
    return { dismissed: count };
  }

  private async openSuggestions() {
    const rows = await this.prisma.knowledgeSuggestion.findMany({
      where: { status: SuggestionStatus.OPEN },
      orderBy: { createdAt: 'desc' },
      include: {
        entry: { select: { id: true, name: true } },
        repairIssue: {
          select: {
            id: true,
            description: true,
            repairTicket: { select: { id: true, repairNumber: true } },
          },
        },
      },
    });
    return rows.map((s) => ({
      id: s.id,
      kind: s.kind,
      body: s.body,
      createdByEmail: s.createdByEmail,
      createdAt: s.createdAt,
      entry: s.entry,
      source: s.repairIssue
        ? {
            issueId: s.repairIssue.id,
            description: s.repairIssue.description,
            ticketId: s.repairIssue.repairTicket.id,
            repairNumber: s.repairIssue.repairTicket.repairNumber,
          }
        : null,
    }));
  }
}
