import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma.service';
import type { AuthUser } from '../../../auth/account-check';
import { whoName } from '../audit-events';
import type {
  CreateLookupValueDto,
  UpdateLookupValueDto,
} from '../dto/lookup-value.dto';
import { isLookupList } from './lookup-lists';
import { lookupNameKey } from './lookup-name';

const DUPLICATE = 'That name is already in the list.';
const SORT_STEP = 10;

const valueSelect = {
  id: true,
  name: true,
  isActive: true,
  sortOrder: true,
} as const;

type Action = 'CREATE' | 'RENAME' | 'DEACTIVATE' | 'REACTIVATE';

@Injectable()
export class LookupsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertList(list: string) {
    if (!isLookupList(list)) throw new NotFoundException('List not found');
  }

  /** Active values of a list, in sort order then name (spec 0016, AC-19). Unknown list: 404. */
  async listActive(list: string) {
    this.assertList(list);
    return this.prisma.lookupValue.findMany({
      where: { list, isActive: true },
      select: valueSelect,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /** Every value, inactive ones too, for the Settings editor. */
  async listAll(list: string) {
    this.assertList(list);
    return this.prisma.lookupValue.findMany({
      where: { list },
      select: valueSelect,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /** Adds a value at the end of the list: the highest sortOrder plus 10 (AC-20). */
  async create(list: string, dto: CreateLookupValueDto, user: AuthUser) {
    this.assertList(list);
    const nameKey = lookupNameKey(dto.name);
    return this.guardDuplicate(() =>
      this.prisma.$transaction(async (tx) => {
        const taken = await tx.lookupValue.findUnique({
          where: { list_nameKey: { list, nameKey } },
          select: { id: true },
        });
        if (taken) throw new ConflictException(DUPLICATE);
        const top = await tx.lookupValue.aggregate({
          _max: { sortOrder: true },
          where: { list },
        });
        const created = await tx.lookupValue.create({
          data: {
            list,
            name: dto.name,
            nameKey,
            sortOrder: (top._max.sortOrder ?? 0) + SORT_STEP,
          },
          select: valueSelect,
        });
        await this.logChange(tx, created.id, 'CREATE', null, created, user);
        return created;
      }),
    );
  }

  /** Renames and/or switches a value on or off. One history row per change. */
  async update(
    list: string,
    id: string,
    dto: UpdateLookupValueDto,
    user: AuthUser,
  ) {
    this.assertList(list);
    if (dto.name === undefined && dto.isActive === undefined) {
      throw new BadRequestException('Send a name or isActive.');
    }
    return this.guardDuplicate(() =>
      this.prisma.$transaction(async (tx) => {
        const current = await tx.lookupValue.findFirst({
          where: { id, list },
          select: valueSelect,
        });
        if (!current) throw new NotFoundException('Value not found');

        const renamed = dto.name !== undefined && dto.name !== current.name;
        const switched =
          dto.isActive !== undefined && dto.isActive !== current.isActive;
        if (!renamed && !switched) return current;

        if (renamed) {
          const nameKey = lookupNameKey(dto.name!);
          const other = await tx.lookupValue.findUnique({
            where: { list_nameKey: { list, nameKey } },
            select: { id: true },
          });
          if (other && other.id !== id) throw new ConflictException(DUPLICATE);
        }

        const updated = await tx.lookupValue.update({
          where: { id },
          data: {
            ...(renamed && {
              name: dto.name,
              nameKey: lookupNameKey(dto.name!),
            }),
            ...(switched && { isActive: dto.isActive }),
          },
          select: valueSelect,
        });
        if (renamed) {
          await this.logChange(tx, id, 'RENAME', current, updated, user);
        }
        if (switched) {
          await this.logChange(
            tx,
            id,
            dto.isActive ? 'REACTIVATE' : 'DEACTIVATE',
            current,
            updated,
            user,
          );
        }
        return updated;
      }),
    );
  }

  private logChange(
    tx: Prisma.TransactionClient,
    lookupValueId: string,
    action: Action,
    before: { name: string; isActive: boolean } | null,
    after: { name: string; isActive: boolean },
    user: AuthUser,
  ) {
    return tx.lookupValueChange.create({
      data: {
        lookupValueId,
        action,
        before: before
          ? { name: before.name, isActive: before.isActive }
          : Prisma.JsonNull,
        after: { name: after.name, isActive: after.isActive },
        actorUserId: user.sub,
        actorName: whoName(user),
        actorEmail: user.email,
      },
    });
  }

  /** A concurrent insert that wins the unique index is the same 409 as the pre check. */
  private async guardDuplicate<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(DUPLICATE);
      }
      throw err;
    }
  }
}
