import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const CHANGE_KINDS = ['all', 'setting', 'permission'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

// Spec 0012, API surface: GET /vrms/settings/changes

export class ListChangesQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(CHANGE_KINDS)
  kind?: ChangeKind;
}
