import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_CHANGES, NOTE_MAX } from '../settings-rules';

// Spec 0012, AC-5 and AC-6. The DTO checks the shape only; types, ranges, notes and
// dependencies come from the catalog in planSave, after the version check.

export class SettingChangeDto {
  @IsString()
  @MaxLength(60)
  key!: string;

  // A number or a boolean, checked against the catalog entry's type by the service
  @IsOptional()
  @Allow()
  value?: unknown;

  @IsOptional()
  @IsIn([true])
  reset?: true;
}

export class UpdateSettingsDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CHANGES)
  @ValidateNested({ each: true })
  @Type(() => SettingChangeDto)
  changes!: SettingChangeDto[];

  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string;
}
