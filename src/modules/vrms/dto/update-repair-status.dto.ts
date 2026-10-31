import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsNumber,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RepairStatus } from '@prisma/client';
import { IsQuarterStep } from '../../knowledge/dto/entry-fields.dto';

// Spec 0007, AC-31: "What fixed it" for one issue, sent on the move to For verification.
export class IssueResolutionDto {
  @IsUUID()
  issueId: string;

  // Required (5 to 500) for an unlinked issue; the service checks that per issue
  @IsOptional()
  @IsString()
  @MaxLength(500)
  resolutionNote?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.25)
  @Max(200)
  @IsQuarterStep('Hours spent go in steps of 0.25.')
  hoursSpent?: number;

  @IsOptional()
  @IsBoolean()
  followedKnownFix?: boolean;
}

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
  @MaxLength(500)
  remarks?: string;

  // Required, so every move runs the stale check (spec 0014, AC-12)
  @IsISO8601()
  lastUpdatedAt: string;

  // Only read on In progress to For verification (spec 0007, AC-31)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => IssueResolutionDto)
  resolutions?: IssueResolutionDto[];
}
