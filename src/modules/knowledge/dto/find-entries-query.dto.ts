import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export const ENTRY_STATUS_FILTERS = [
  'ACTIVE',
  'DRAFT',
  'INACTIVE',
  'ALL',
] as const;
export type EntryStatusFilter = (typeof ENTRY_STATUS_FILTERS)[number];

export const ENTRY_SORTS = ['seen', 'updated', 'name'] as const;
export type EntrySort = (typeof ENTRY_SORTS)[number];

export class FindEntriesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  // Forced to ACTIVE for a mechanic
  @IsOptional()
  @IsIn(ENTRY_STATUS_FILTERS)
  status?: EntryStatusFilter;

  @IsOptional()
  @IsIn(ENTRY_SORTS)
  sort?: EntrySort;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
