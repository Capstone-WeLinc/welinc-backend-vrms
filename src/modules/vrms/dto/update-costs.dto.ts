import {
  IsBoolean,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsArray,
  ValidateNested,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RepairPartDto {
  @IsString()
  @MaxLength(255)
  description: string;

  @IsNumber()
  @Min(0)
  unitCost: number;

  @IsNumber()
  @Min(1)
  quantity: number;
}

export class UpdateCostsDto {
  @IsBoolean()
  isLumpSum: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  partsCost?: number; // used in lump sum mode

  @IsOptional()
  @IsNumber()
  @Min(0)
  laborCost?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RepairPartDto)
  parts?: RepairPartDto[]; // used in itemized mode

  // Required, so a costs save runs the stale check (spec 0014, AC-12)
  @IsISO8601()
  lastUpdatedAt: string;
}
