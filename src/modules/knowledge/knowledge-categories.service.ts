import { BadRequestException, Injectable } from '@nestjs/common';
import { IssueCategory, KnowledgeEntryStatus } from '@prisma/client';
import { PrismaService } from '../../shared/prisma.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { ListCategoriesQueryDto } from './dto/list-categories-query.dto';
import { isKnowledgeEditor, JwtUser } from './knowledge-actor';
import {
  changeRows,
  diffFields,
  duplicateConflict,
  isUniqueViolation,
  loadedAt,
  nameKey,
  notFound,
  staleConflict,
} from './knowledge-changes';

const STALE_CATEGORY =
  'Someone else changed this category. Reload to see their changes.';

function view(c: IssueCategory & { _count: { entries: number } }) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
    entryCount: c._count.entries,
    updatedAt: c.updatedAt,
  };
}

const withCount = { _count: { select: { entries: true } } } as const;

@Injectable()
export class KnowledgeCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** In sortOrder, with the entry count over every status. Inactive ones only for editors who ask. */
  async list(query: ListCategoriesQueryDto, user: JwtUser) {
    const includeInactive =
      query.includeInactive === true && isKnowledgeEditor(user);
    const categories = await this.prisma.issueCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: withCount,
    });
    return categories.map(view);
  }

  /** POST /vrms/knowledge/categories: a new one goes last (AC-22). */
  async create(dto: CreateCategoryDto, user: JwtUser) {
    await this.assertNameFree(dto.name);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const last = await tx.issueCategory.aggregate({
          _max: { sortOrder: true },
        });
        const category = await tx.issueCategory.create({
          data: {
            name: dto.name,
            nameKey: nameKey(dto.name),
            description: dto.description ?? null,
            sortOrder: (last._max.sortOrder ?? 0) + 1,
          },
          include: withCount,
        });
        await tx.knowledgeEntryChange.createMany({
          data: changeRows(
            user,
            'CATEGORY_CREATED',
            { categoryId: category.id },
            [{ fieldName: 'name', previousValue: null, newValue: dto.name }],
          ),
        });
        return category;
      });
      return view(created);
    } catch (err) {
      if (isUniqueViolation(err)) throw this.duplicate(dto.name);
      throw err;
    }
  }

  /**
   * PATCH /vrms/knowledge/categories/:id. A new sortOrder swaps places with the category holding
   * it (Move up, Move down). Deactivating needs no Active or Draft entries left (AC-23).
   */
  async update(id: string, dto: UpdateCategoryDto, user: JwtUser) {
    const existing = await this.prisma.issueCategory.findUnique({
      where: { id },
    });
    if (!existing) throw notFound('category');
    if (dto.name !== undefined) await this.assertNameFree(dto.name, id);

    if (dto.isActive === false && existing.isActive) {
      const open = await this.prisma.knowledgeEntry.count({
        where: {
          categoryId: id,
          status: {
            in: [KnowledgeEntryStatus.ACTIVE, KnowledgeEntryStatus.DRAFT],
          },
        },
      });
      if (open > 0) {
        throw new BadRequestException(
          `Move or deactivate its ${open} ${open === 1 ? 'entry' : 'entries'} first.`,
        );
      }
    }

    const fields = diffFields(
      {
        name: existing.name,
        description: existing.description,
        sortOrder: String(existing.sortOrder),
      },
      {
        name: dto.name ?? existing.name,
        description:
          dto.description === undefined
            ? existing.description
            : dto.description,
        sortOrder: String(dto.sortOrder ?? existing.sortOrder),
      },
    );
    const status =
      dto.isActive === undefined || dto.isActive === existing.isActive
        ? []
        : [
            {
              fieldName: 'isActive',
              previousValue: String(existing.isActive),
              newValue: String(dto.isActive),
            },
          ];

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.issueCategory.updateMany({
          where: { id, updatedAt: loadedAt(dto.lastUpdatedAt) },
          data: {
            ...(dto.name !== undefined
              ? { name: dto.name, nameKey: nameKey(dto.name) }
              : {}),
            ...(dto.description !== undefined
              ? { description: dto.description }
              : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            ...(dto.sortOrder !== undefined
              ? { sortOrder: dto.sortOrder }
              : {}),
          },
        });
        if (count === 0) throw staleConflict(STALE_CATEGORY);

        if (
          dto.sortOrder !== undefined &&
          dto.sortOrder !== existing.sortOrder
        ) {
          const neighbour = await tx.issueCategory.findFirst({
            where: { sortOrder: dto.sortOrder, id: { not: id } },
          });
          if (neighbour) {
            await tx.issueCategory.update({
              where: { id: neighbour.id },
              data: { sortOrder: existing.sortOrder },
            });
            await tx.knowledgeEntryChange.createMany({
              data: changeRows(
                user,
                'CATEGORY_UPDATED',
                { categoryId: neighbour.id },
                [
                  {
                    fieldName: 'sortOrder',
                    previousValue: String(neighbour.sortOrder),
                    newValue: String(existing.sortOrder),
                  },
                ],
              ),
            });
          }
        }

        await tx.knowledgeEntryChange.createMany({
          data: [
            ...changeRows(user, 'CATEGORY_UPDATED', { categoryId: id }, fields),
            ...changeRows(user, 'CATEGORY_STATUS', { categoryId: id }, status),
          ],
        });
        return tx.issueCategory.findUniqueOrThrow({
          where: { id },
          include: withCount,
        });
      });
      return view(updated);
    } catch (err) {
      if (isUniqueViolation(err)) throw this.duplicate(dto.name ?? '');
      throw err;
    }
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const clash = await this.prisma.issueCategory.findUnique({
      where: { nameKey: nameKey(name) },
      select: { id: true },
    });
    if (clash && clash.id !== exceptId) throw this.duplicate(name);
  }

  private duplicate(name: string) {
    return duplicateConflict(`A category named '${name}' already exists.`);
  }
}
