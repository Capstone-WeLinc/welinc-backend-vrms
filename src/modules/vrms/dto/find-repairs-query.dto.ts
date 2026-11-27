import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { RepairStatus } from '@prisma/client';

export class FindRepairsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  // Any status, as before; without it the list holds open tickets only
  @IsOptional()
  @IsEnum(RepairStatus)
  status?: RepairStatus;

  @IsOptional()
  @IsUUID()
  garageId?: string;

  // Ignored for mechanics: their list is always their own tickets
  @IsOptional()
  @IsUUID()
  mechanicId?: string;

  // Only the literal strings "true" and "false" count; anything else fails @IsBoolean
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  overdue?: boolean;

  // Spec 0029, AC-35: open tickets whose truck VMMS removed (the dashboard card's list)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  truckRemoved?: boolean;

  // VRMS spec 0027, AC-4: a sidebar preset (open, signoff, mine, active, sentBack, done). Checked
  // in the service, so an unknown one answers 400 VALIDATION_FAILED and a forbidden one 403.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  view?: string;

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
