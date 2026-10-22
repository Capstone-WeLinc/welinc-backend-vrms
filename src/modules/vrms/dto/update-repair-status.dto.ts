import {
  IsEnum,
  IsOptional,
  IsString,
  IsNumber,
  MaxLength,
  Min,
} from 'class-validator';
import { RepairStatus } from '@prisma/client';

export class UpdateRepairStatusDto {
  @IsEnum(RepairStatus)
  status: RepairStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancellationReason?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  partsCost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  laborCost?: number;

  @IsOptional()
  @IsString()
  failedVerificationReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string;

  @IsOptional()
  @IsString()
  lastUpdatedAt?: string;
}

