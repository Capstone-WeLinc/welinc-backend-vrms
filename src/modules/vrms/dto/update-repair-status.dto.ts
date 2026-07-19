import { IsEnum, IsOptional, IsString, IsNumber, Min } from 'class-validator';
import { RepairStatus } from '@prisma/client';

export class UpdateRepairStatusDto {
  @IsEnum(RepairStatus)
  status: RepairStatus;

  @IsOptional()
  @IsString()
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
  remarks?: string;

  @IsOptional()
  @IsString()
  lastUpdatedAt?: string;
}

