import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { RepairStatus } from '@prisma/client';
import { FINISHED_STATUSES } from '../ticket-statuses';

export class HistoryQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(FINISHED_STATUSES)
  status?: RepairStatus;

  @IsOptional()
  @IsUUID()
  garageId?: string;

  // Feature 23: only tickets this user verified (closed ones; cancelled have no verifier)
  @IsOptional()
  @IsUUID()
  verifiedBy?: string;

  // On closedAt: `from` inclusive, `to` exclusive
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // No upper cap: the dashboard asks for every row at once
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
