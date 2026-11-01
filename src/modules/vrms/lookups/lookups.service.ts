import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import { isLookupList } from './lookup-lists';

@Injectable()
export class LookupsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active values of a list, in sort order then name (spec 0016, AC-19). Unknown list: 404. */
  async listActive(list: string) {
    if (!isLookupList(list)) throw new NotFoundException('List not found');
    return this.prisma.lookupValue.findMany({
      where: { list, isActive: true },
      select: { id: true, name: true, isActive: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }
}
